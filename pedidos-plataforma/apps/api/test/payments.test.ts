import { createHmac, randomBytes } from 'node:crypto';
import { allSql } from '../db/schema.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../src/crypto-box';
import { withContext, type Database } from '../src/db';
import { createOrder, markPaymentApproved, transitionOrder } from '../src/order-service';
import { MercadoPagoProvider, mpStatus } from '../src/payments/mercadopago';
import { expireUnpaidOrders, handlePaymentWebhook, processPendingRefunds, type PaymentDeps } from '../src/payments/payment-service';
import type { PaymentProvider, ProviderPayment, WebhookRequest } from '../src/payments/provider';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let pg: PGlite;
let db: Database;
const KEY = randomBytes(32);
const ROLE = 'app_runtime';

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(allSql());
  db = pg as unknown as Database;
});
const one = async (sql: string, params: unknown[] = []) => (await pg.query<Row>(sql, params)).rows[0] as Row;
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code?: string }).code ?? (e as Error).message; } return null; };

/* ---------- proveedor simulado ---------- */
class FakeProvider implements PaymentProvider {
  readonly name = 'mercadopago';
  async createCheckout() { return { checkoutUrl: 'https://pago.fake/checkout', providerReference: null }; }
  payments = new Map<string, ProviderPayment>();
  refundCalls: { paymentId: string; amountCents: number; key: string }[] = [];
  failGetPayment = false;
  failRefunds = false;
  verifyWebhookSignature(req: WebhookRequest, secret: string) { return req.headers['x-signature'] === 'ok:' + secret; }
  parseWebhook(req: WebhookRequest) {
    const b = JSON.parse(req.rawBody);
    return { eventId: String(b.id), type: (b.type === 'payment' ? 'payment' : 'other') as 'payment' | 'other', resourceId: String(b.data.id), accountId: String(b.user_id) };
  }
  async getPayment(_t: string, id: string) {
    if (this.failGetPayment) throw new Error('proveedor caído');
    const p = this.payments.get(id); if (!p) throw new Error('pago inexistente'); return p;
  }
  async refund(_t: string, paymentId: string, amountCents: number, key: string) {
    this.refundCalls.push({ paymentId, amountCents, key });
    if (this.failRefunds) throw new Error('refund 500');
    return { refundId: 'RF-' + this.refundCalls.length };
  }
}

interface Seed { id: string; customer: string; staff: string; accountId: string; product: string }
let seq = 0;
async function seedTenant(): Promise<Seed> {
  const n = ++seq;
  const t = (await one("INSERT INTO tenants (name, slug) VALUES ($1,$2) RETURNING id", ['L' + n, 'pay-' + n])).id;
  const customer = (await one("INSERT INTO users (email, name) VALUES ($1,'C') RETURNING id", [`pc${n}@x.com`])).id;
  const staff = (await one("INSERT INTO users (email, name) VALUES ($1,'S') RETURNING id", [`ps${n}@x.com`])).id;
  await pg.query('INSERT INTO tenant_settings (tenant_id) VALUES ($1)', [t]);
  await pg.query("INSERT INTO tenant_payment_methods (tenant_id, method, enabled) VALUES ($1,'payment_app',true)", [t]);
  await pg.query("INSERT INTO pickup_points (tenant_id, name, is_default) VALUES ($1,'Barra',true)", [t]);
  const menu = (await one("INSERT INTO menus (tenant_id, name, is_default) VALUES ($1,'Carta',true) RETURNING id", [t])).id;
  const cat = (await one("INSERT INTO categories (tenant_id, menu_id, name) VALUES ($1,$2,'Todo') RETURNING id", [t, menu])).id;
  const product = (await one("INSERT INTO products (tenant_id, category_id, name, base_price_cents) VALUES ($1,$2,'Papas',520000) RETURNING id", [t, cat])).id;
  const accountId = 'MPACC-' + n;
  await pg.query("INSERT INTO tenant_payment_accounts (tenant_id, provider, provider_account_id, access_token_enc) VALUES ($1,'mercadopago',$2,$3)", [t, accountId, encryptSecret('APP_USR-token', KEY)]);
  return { id: t, customer, staff, accountId, product };
}

const SECRET = 'whsec';
const deps = (provider: FakeProvider): PaymentDeps => ({ db, provider, webhookSecret: SECRET, encryptionKey: KEY, role: ROLE });
let k = 0;
const newOrder = async (s: Seed) => withContext(db, { tenantId: s.id, userId: s.customer, role: ROLE }, (tx) =>
  createOrder(tx, { tenantId: s.id, userId: s.customer, idempotencyKey: 'k' + ++k, paymentMethod: 'payment_app', items: [{ productId: s.product, quantity: 1, selections: {} }] }));
const hook = (s: Seed, paymentId: string, eventId = 'EV-' + ++k, signature = 'ok:' + SECRET): WebhookRequest => ({
  rawBody: JSON.stringify({ id: eventId, type: 'payment', action: 'payment.updated', user_id: s.accountId, data: { id: paymentId } }),
  headers: { 'x-signature': signature },
});
const mpPayment = (id: string, orderId: string, amountCents: number, status: ProviderPayment['status'] = 'approved'): ProviderPayment =>
  ({ id, status, amountCents, currency: 'ARS', externalReference: orderId });
const orderRow = (id: string) => one('SELECT operational_status, payment_status FROM orders WHERE id=$1', [id]);

describe('webhook de pago', () => {
  it('aprueba el pedido consultando el estado real al proveedor', async () => {
    const s = await seedTenant(); const o = await newOrder(s); const prov = new FakeProvider();
    prov.payments.set(`P1-${s.id}`, mpPayment(`P1-${s.id}`, o.orderId, o.totalCents));
    expect(await handlePaymentWebhook(deps(prov), hook(s, `P1-${s.id}`))).toEqual({ outcome: 'processed' });
    expect(await orderRow(o.orderId)).toMatchObject({ operational_status: 'pending_acceptance', payment_status: 'approved' });
    expect((await one("SELECT processed_at, error FROM payment_events WHERE tenant_id=$1", [s.id])).processed_at).not.toBeNull();
  });

  it('un webhook con el mismo id de evento no se procesa dos veces', async () => {
    const s = await seedTenant(); const o = await newOrder(s); const prov = new FakeProvider();
    prov.payments.set(`P1-${s.id}`, mpPayment(`P1-${s.id}`, o.orderId, o.totalCents));
    const req = hook(s, `P1-${s.id}`, 'EV-SAME');
    await handlePaymentWebhook(deps(prov), req);
    expect(await handlePaymentWebhook(deps(prov), req)).toEqual({ outcome: 'duplicate' });
    expect((await one('SELECT count(*)::int n FROM payments WHERE order_id=$1', [o.orderId])).n).toBe(1);
  });

  it('dos notificaciones distintas del mismo pago no lo duplican', async () => {
    const s = await seedTenant(); const o = await newOrder(s); const prov = new FakeProvider();
    prov.payments.set(`P1-${s.id}`, mpPayment(`P1-${s.id}`, o.orderId, o.totalCents));
    await handlePaymentWebhook(deps(prov), hook(s, `P1-${s.id}`, 'EV-A'));
    await handlePaymentWebhook(deps(prov), hook(s, `P1-${s.id}`, 'EV-B'));
    expect((await one('SELECT count(*)::int n FROM payments WHERE order_id=$1', [o.orderId])).n).toBe(1);
    expect((await one("SELECT count(*)::int n FROM order_status_history WHERE order_id=$1 AND axis='payment'", [o.orderId])).n).toBe(1);
  });

  it('rechaza webhooks con firma inválida sin escribir nada', async () => {
    const s = await seedTenant(); const prov = new FakeProvider();
    expect(await code(handlePaymentWebhook(deps(prov), hook(s, `P1-${s.id}`, 'EV-X', 'forjada')))).toBe('INVALID_SIGNATURE');
    expect((await one('SELECT count(*)::int n FROM payment_events WHERE tenant_id=$1', [s.id])).n).toBe(0);
  });

  it('rechaza cuentas desconocidas', async () => {
    const s = await seedTenant(); const prov = new FakeProvider();
    const req = hook({ ...s, accountId: 'NADIE' }, `P1-${s.id}`);
    expect(await code(handlePaymentWebhook(deps(prov), req))).toBe('UNKNOWN_ACCOUNT');
  });

  it('ignora eventos que no son de pagos', async () => {
    const s = await seedTenant(); const prov = new FakeProvider();
    const req = { rawBody: JSON.stringify({ id: 'E', type: 'merchant_order', user_id: s.accountId, data: { id: '1' } }), headers: { 'x-signature': 'ok:' + SECRET } };
    expect(await handlePaymentWebhook(deps(prov), req)).toEqual({ outcome: 'ignored' });
  });

  it('un importe que no coincide queda para revisión humana y no aprueba el pedido', async () => {
    const s = await seedTenant(); const o = await newOrder(s); const prov = new FakeProvider();
    prov.payments.set(`P1-${s.id}`, mpPayment(`P1-${s.id}`, o.orderId, o.totalCents - 100));
    expect(await handlePaymentWebhook(deps(prov), hook(s, `P1-${s.id}`))).toEqual({ outcome: 'needs_review' });
    expect(await orderRow(o.orderId)).toMatchObject({ operational_status: 'awaiting_payment', payment_status: 'pending' });
    expect((await one("SELECT count(*)::int n FROM outbox_events WHERE type='payment.needs_review' AND tenant_id=$1", [s.id])).n).toBe(1);
    expect((await one('SELECT error FROM payment_events WHERE tenant_id=$1', [s.id])).error).toBe('AMOUNT_MISMATCH');
  });

  it('una referencia externa inválida queda para revisión', async () => {
    const s = await seedTenant(); const prov = new FakeProvider();
    prov.payments.set(`P1-${s.id}`, { ...mpPayment(`P1-${s.id}`, 'no-es-uuid', 1), externalReference: 'no-es-uuid' });
    expect(await handlePaymentWebhook(deps(prov), hook(s, `P1-${s.id}`))).toEqual({ outcome: 'needs_review' });
  });

  it('un pago de un local no puede afectar pedidos de otro local', async () => {
    const a = await seedTenant(); const b = await seedTenant(); const prov = new FakeProvider();
    const orderB = await newOrder(b);
    prov.payments.set(`P1-${a.id}`, mpPayment(`P1-${a.id}`, orderB.orderId, orderB.totalCents));
    expect(await handlePaymentWebhook(deps(prov), hook(a, `P1-${a.id}`))).toEqual({ outcome: 'needs_review' });
    expect(await orderRow(orderB.orderId)).toMatchObject({ operational_status: 'awaiting_payment' });
  });

  it('un intento rechazado no cancela el pedido: el cliente puede reintentar y pagar', async () => {
    const s = await seedTenant(); const o = await newOrder(s); const prov = new FakeProvider();
    prov.payments.set(`P1-${s.id}`, mpPayment(`P1-${s.id}`, o.orderId, o.totalCents, 'rejected'));
    await handlePaymentWebhook(deps(prov), hook(s, `P1-${s.id}`));
    expect(await orderRow(o.orderId)).toMatchObject({ operational_status: 'awaiting_payment', payment_status: 'pending' });
    expect((await one('SELECT status FROM payments WHERE provider_payment_id=$1', [`P1-${s.id}`])).status).toBe('rejected');
    prov.payments.set(`P2-${s.id}`, mpPayment(`P2-${s.id}`, o.orderId, o.totalCents));
    await handlePaymentWebhook(deps(prov), hook(s, `P2-${s.id}`));
    expect(await orderRow(o.orderId)).toMatchObject({ operational_status: 'pending_acceptance', payment_status: 'approved' });
  });

  it('si el proveedor falla, el error se registra y el reintento posterior sí procesa', async () => {
    const s = await seedTenant(); const o = await newOrder(s); const prov = new FakeProvider();
    prov.payments.set(`P1-${s.id}`, mpPayment(`P1-${s.id}`, o.orderId, o.totalCents));
    prov.failGetPayment = true;
    const req = hook(s, `P1-${s.id}`, 'EV-RETRY');
    expect(await code(handlePaymentWebhook(deps(prov), req))).toBe('proveedor caído');
    expect((await one('SELECT processed_at FROM payment_events WHERE tenant_id=$1', [s.id])).processed_at).toBeNull();
    prov.failGetPayment = false;
    expect(await handlePaymentWebhook(deps(prov), req)).toEqual({ outcome: 'processed' });
    expect(await orderRow(o.orderId)).toMatchObject({ payment_status: 'approved' });
  });
});

describe('pedidos sin pagar', () => {
  it('vence solo los pedidos viejos y un pago tardío se reembolsa', async () => {
    const s = await seedTenant(); const old = await newOrder(s); const fresh = await newOrder(s); const prov = new FakeProvider();
    await pg.query("UPDATE orders SET placed_at = now() - interval '30 minutes' WHERE id=$1", [old.orderId]);
    expect(await expireUnpaidOrders(db, { olderThanMinutes: 15, role: ROLE })).toBe(1);
    expect(await orderRow(old.orderId)).toMatchObject({ operational_status: 'cancelled', payment_status: 'expired' });
    expect(await orderRow(fresh.orderId)).toMatchObject({ operational_status: 'awaiting_payment', payment_status: 'pending' });

    prov.payments.set(`LATE-${s.id}`, mpPayment(`LATE-${s.id}`, old.orderId, old.totalCents));
    await handlePaymentWebhook(deps(prov), hook(s, `LATE-${s.id}`));
    expect((await one('SELECT count(*)::int n FROM refunds WHERE tenant_id=$1', [s.id])).n).toBe(1);
    expect(await processPendingRefunds(deps(prov))).toMatchObject({ succeeded: 1 });
    expect(prov.refundCalls).toHaveLength(1);
  });
});

describe('reembolsos', () => {
  async function rejectedPaidOrder(s: Seed, prov: FakeProvider) {
    const o = await newOrder(s);
    prov.payments.set('P' + o.orderId, mpPayment('P' + o.orderId, o.orderId, o.totalCents));
    await handlePaymentWebhook(deps(prov), hook(s, 'P' + o.orderId));
    await withContext(db, { tenantId: s.id, userId: s.staff, role: ROLE }, (tx) =>
      transitionOrder(tx, { tenantId: s.id, orderId: o.orderId, to: 'rejected', actor: 'staff', actorUserId: s.staff, reasonCode: 'out_of_stock' }));
    return o;
  }

  it('reembolsa el total con clave de idempotencia y deja el pedido y el pago en "reembolsado"', async () => {
    const s = await seedTenant(); const prov = new FakeProvider(); const o = await rejectedPaidOrder(s, prov);
    expect(await processPendingRefunds(deps(prov))).toEqual({ succeeded: 1, retry: 0, failed: 0 });
    const refund = await one('SELECT id, status, provider_refund_id FROM refunds WHERE tenant_id=$1', [s.id]);
    expect(refund).toMatchObject({ status: 'succeeded', provider_refund_id: 'RF-1' });
    expect(prov.refundCalls[0]).toMatchObject({ amountCents: o.totalCents, key: `refund-${refund.id}` });
    expect(await orderRow(o.orderId)).toMatchObject({ operational_status: 'rejected', payment_status: 'refunded' });
    expect((await one('SELECT status FROM payments WHERE order_id=$1', [o.orderId])).status).toBe('refunded');
  });

  it('no reembolsa dos veces aunque el trabajador corra de nuevo', async () => {
    const s = await seedTenant(); const prov = new FakeProvider(); await rejectedPaidOrder(s, prov);
    await processPendingRefunds(deps(prov));
    expect(await processPendingRefunds(deps(prov))).toEqual({ succeeded: 0, retry: 0, failed: 0 });
    expect(prov.refundCalls).toHaveLength(1);
  });

  it('reintenta ante fallos y, al agotar los intentos, queda "failed" con alerta', async () => {
    const s = await seedTenant(); const prov = new FakeProvider(); const o = await rejectedPaidOrder(s, prov);
    prov.failRefunds = true;
    expect(await processPendingRefunds(deps(prov), { maxAttempts: 3 })).toEqual({ succeeded: 0, retry: 1, failed: 0 });
    expect(await processPendingRefunds(deps(prov), { maxAttempts: 3 })).toEqual({ succeeded: 0, retry: 1, failed: 0 });
    expect(await processPendingRefunds(deps(prov), { maxAttempts: 3 })).toEqual({ succeeded: 0, retry: 0, failed: 1 });
    expect(await one('SELECT status, attempts, last_error FROM refunds WHERE tenant_id=$1', [s.id])).toMatchObject({ status: 'failed', attempts: 3, last_error: 'refund 500' });
    expect((await one("SELECT count(*)::int n FROM outbox_events WHERE type='refund.failed' AND tenant_id=$1", [s.id])).n).toBe(1);
    expect((await orderRow(o.orderId)).payment_status).toBe('refund_pending');   // sigue pendiente: requiere atención
    expect(await processPendingRefunds(deps(prov), { maxAttempts: 3 })).toEqual({ succeeded: 0, retry: 0, failed: 0 });
  });

  it('se recupera si el proveedor vuelve antes de agotar los intentos', async () => {
    const s = await seedTenant(); const prov = new FakeProvider(); const o = await rejectedPaidOrder(s, prov);
    prov.failRefunds = true;
    await processPendingRefunds(deps(prov));
    prov.failRefunds = false;
    expect(await processPendingRefunds(deps(prov))).toEqual({ succeeded: 1, retry: 0, failed: 0 });
    expect((await orderRow(o.orderId)).payment_status).toBe('refunded');
    expect(new Set(prov.refundCalls.map((c) => c.key)).size).toBe(1);   // misma clave en los reintentos
  });
});

describe('directorio de cuentas', () => {
  it('se mantiene al conectar y desconectar la cuenta del local', async () => {
    const s = await seedTenant();
    expect((await one("SELECT tenant_id FROM provider_account_directory WHERE provider_account_id=$1", [s.accountId])).tenant_id).toBe(s.id);
    await pg.query('DELETE FROM tenant_payment_accounts WHERE tenant_id=$1', [s.id]);
    expect(await one("SELECT 1 FROM provider_account_directory WHERE provider_account_id=$1", [s.accountId])).toBeUndefined();
  });
});

describe('cifrado de credenciales', () => {
  it('cifra y descifra, y detecta manipulación o clave incorrecta', () => {
    const boxed = encryptSecret('APP_USR-123', KEY);
    expect(boxed).not.toContain('APP_USR');
    expect(decryptSecret(boxed, KEY)).toBe('APP_USR-123');
    expect(encryptSecret('APP_USR-123', KEY)).not.toBe(boxed);   // IV aleatorio
    const parts = boxed.split('.'); parts[3] = Buffer.from('otro').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), KEY)).toThrow();
    expect(() => decryptSecret(boxed, randomBytes(32))).toThrow();
    expect(() => encryptSecret('x', Buffer.alloc(16))).toThrow(/32 bytes/);
  });
});

describe('adaptador de Mercado Pago (con respuestas simuladas)', () => {
  const NOW = 1_800_000_000_000;
  const signed = (ts: number, id = '123', requestId = 'req-1', secret = 'sec') => {
    const sig = createHmac('sha256', secret).update(`id:${id};request-id:${requestId};ts:${ts};`).digest('hex');
    return { rawBody: JSON.stringify({ id: 99, type: 'payment', action: 'payment.created', user_id: 555, data: { id } }),
      headers: { 'x-signature': `ts=${ts},v1=${sig}`, 'x-request-id': requestId } } as WebhookRequest;
  };
  const mp = new MercadoPagoProvider({ now: () => NOW });

  it('valida la firma y rechaza firmas alteradas, viejas o incompletas', () => {
    expect(mp.verifyWebhookSignature(signed(NOW), 'sec')).toBe(true);
    expect(mp.verifyWebhookSignature(signed(NOW), 'otro-secreto')).toBe(false);
    expect(mp.verifyWebhookSignature(signed(NOW - 10 * 60_000), 'sec')).toBe(false);      // anti-repetición
    const tampered = signed(NOW); tampered.rawBody = tampered.rawBody.replace('"123"', '"999"');
    expect(mp.verifyWebhookSignature(tampered, 'sec')).toBe(false);
    expect(mp.verifyWebhookSignature({ rawBody: '{}', headers: {} }, 'sec')).toBe(false);
    expect(mp.verifyWebhookSignature(signed(NOW), '')).toBe(false);
  });

  it('interpreta la notificación', () => {
    expect(mp.parseWebhook(signed(NOW))).toEqual({ eventId: '99', type: 'payment', resourceId: '123', accountId: '555' });
    expect(mp.parseWebhook({ rawBody: 'no json', headers: {} })).toBeNull();
    expect(mp.parseWebhook({ rawBody: '{"data":{}}', headers: {} })).toBeNull();
  });

  it('traduce estados', () => {
    expect([mpStatus('approved'), mpStatus('in_process'), mpStatus('cancelled'), mpStatus('rejected'), mpStatus('refunded'), mpStatus('x')])
      .toEqual(['approved', 'pending', 'rejected', 'rejected', 'refunded', 'other']);
  });

  it('consulta el pago y convierte pesos a centavos sin errores de redondeo', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const f = (async (url: string, init?: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: 7, status: 'approved', transaction_amount: 4200.1, currency_id: 'ARS', external_reference: 'ord-1' })); }) as unknown as typeof fetch;
    const p = await new MercadoPagoProvider({ fetchImpl: f }).getPayment('TOKEN', '7');
    expect(p).toEqual({ id: '7', status: 'approved', amountCents: 420010, currency: 'ARS', externalReference: 'ord-1' });
    expect(calls[0]?.url).toContain('/v1/payments/7');
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe('Bearer TOKEN');
  });

  it('el reembolso envía clave de idempotencia y el monto en pesos', async () => {
    let seen: { init?: RequestInit } = {};
    const f = (async (_u: string, init?: RequestInit) => { seen = { init }; return new Response(JSON.stringify({ id: 'R1' })); }) as unknown as typeof fetch;
    expect(await new MercadoPagoProvider({ fetchImpl: f }).refund('T', '7', 420010, 'refund-abc')).toEqual({ refundId: 'R1' });
    expect((seen.init?.headers as Record<string, string>)['X-Idempotency-Key']).toBe('refund-abc');
    expect(JSON.parse(String(seen.init?.body))).toEqual({ amount: 4200.1 });
  });

  it('falla de forma explícita ante errores HTTP del proveedor', async () => {
    const f = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    await expect(new MercadoPagoProvider({ fetchImpl: f }).getPayment('T', '1')).rejects.toThrow(/500/);
  });
});

// Evita que el linter marque la importación usada solo en tipos.
void markPaymentApproved;
