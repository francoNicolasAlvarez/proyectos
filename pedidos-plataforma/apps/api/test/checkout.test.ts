import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allSql } from '../db/schema.mjs';
import { encryptSecret } from '../src/crypto-box';
import type { Database } from '../src/db';
import { buildApp } from '../src/http/app';
import { MercadoPagoProvider } from '../src/payments/mercadopago';
import { SimulatedProvider } from '../src/payments/simulated';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ORIGIN = 'https://app.test';
const API = 'http://localhost:3000';
const KEY = randomBytes(32);
const SECRET = 'webhook-secret-de-prueba';
let pg: PGlite; let app: FastifyInstance; let bare: FastifyInstance;
const sim = new SimulatedProvider(API);

const config = (over: Record<string, unknown> = {}) => ({
  db: pg as unknown as Database, pickupSecret: 'p', webhookSecret: SECRET, encryptionKey: KEY, provider: sim,
  allowedOrigins: [ORIGIN, API], publicApiUrl: API, appBaseUrl: ORIGIN, secureCookies: false, dbRole: 'app_runtime', scryptCost: 2 ** 10, ...over,
});

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(allSql());
  app = await buildApp({ ...config(), simulated: sim });
  bare = await buildApp(config({ simulated: undefined }));   // sin pago simulado: como en producción
});
afterAll(async () => { await app.close(); await bare.close(); });

const one = async (sql: string, p: unknown[] = []) => (await pg.query<Row>(sql, p)).rows[0] as Row;
const safe = (s: string) => { try { return JSON.parse(s); } catch { return s; } };

class Client {
  sid: string | undefined;
  async req(method: 'GET' | 'POST', url: string, body?: unknown, headers: Record<string, string> = {}, on: FastifyInstance = app) {
    const h: Record<string, string> = { ...headers };
    if (this.sid) h.cookie = `sid=${this.sid}`;
    if (this.sid && method === 'POST') h.origin = ORIGIN;
    const res = await on.inject({ method, url, headers: h, payload: body as object | undefined });
    const m = /sid=([^;]*)/.exec(String(res.headers['set-cookie'] ?? ''));
    if (m) this.sid = m[1] || undefined;
    return { status: res.statusCode, body: safe(res.body), type: String(res.headers['content-type'] ?? '') };
  }
}

let seq = 0;
async function user() {
  const c = new Client(); const email = `co${++seq}@mail.com`;
  await c.req('POST', '/auth/register', { email, name: 'U', password: 'una-clave-larga', adultDeclared: true });
  await c.req('POST', '/auth/login', { email, password: 'una-clave-larga' });
  return c;
}
async function seedTenant(opts: { account?: boolean } = {}) {
  const n = ++seq;
  const slug = 'co-' + n;
  const t = (await one("INSERT INTO tenants (name, slug) VALUES ($1,$2) RETURNING id", ['Bar ' + n, slug])).id as string;
  await pg.query('INSERT INTO tenant_settings (tenant_id) VALUES ($1)', [t]);
  await pg.query("INSERT INTO tenant_payment_methods (tenant_id, method, enabled) VALUES ($1,'payment_app',true)", [t]);
  await pg.query("INSERT INTO pickup_points (tenant_id, name, is_default) VALUES ($1,'Barra',true)", [t]);
  const menu = (await one("INSERT INTO menus (tenant_id, name, is_default) VALUES ($1,'Carta',true) RETURNING id", [t])).id;
  const cat = (await one("INSERT INTO categories (tenant_id, menu_id, name) VALUES ($1,$2,'C') RETURNING id", [t, menu])).id;
  const beer = (await one("INSERT INTO products (tenant_id, category_id, name, base_price_cents) VALUES ($1,$2,'Rubia Lager',420000) RETURNING id", [t, cat])).id;
  if (opts.account !== false) {
    await pg.query("INSERT INTO tenant_payment_accounts (tenant_id, provider, provider_account_id, access_token_enc) VALUES ($1,'simulated',$2,$3)", [t, 'SIM-' + n, encryptSecret('simulated', KEY)]);
  }
  return { id: t, slug, beer };
}
let k = 0;
const makeOrder = async (c: Client, s: { slug: string; beer: string }, qty = 2) => {
  const r = await c.req('POST', `/venues/${s.slug}/orders`, { paymentMethod: 'payment_app', items: [{ productId: s.beer, quantity: qty, selections: {} }] }, { 'idempotency-key': 'co-key-' + ++k });
  return r.body as { orderId: string; totalCents: number };
};
const state = async (c: Client, id: string) => (await c.req('GET', `/orders/${id}`)).body as Row;

describe('iniciar el cobro (pago simulado)', () => {
  it('pedir → iniciar cobro → aprobar: el pedido llega al local ya pagado', async () => {
    const s = await seedTenant(); const c = await user();
    const o = await makeOrder(c, s);
    const co = await c.req('POST', `/orders/${o.orderId}/checkout`);
    expect(co.status).toBe(200);
    expect(co.body.checkoutUrl).toBe(`${API}/dev/pay/${o.orderId}`);

    const page = await new Client().req('GET', `/dev/pay/${o.orderId}`);
    expect(page.status).toBe(200);
    expect(page.type).toContain('text/html');
    expect(page.body).toContain('Pago SIMULADO');
    expect(page.body).toContain('Pedido #001');

    const paid = await new Client().req('POST', `/dev/pay/${o.orderId}/approve`);
    expect(paid.body).toMatchObject({ outcome: 'processed', returnUrl: `${ORIGIN}/orders/${o.orderId}?pago=ok` });
    expect(await state(c, o.orderId)).toMatchObject({ status: 'pending_acceptance', paymentStatus: 'approved' });
  });

  it('el cobro lleva el detalle, el importe, la fecha de vencimiento y las direcciones correctas', async () => {
    const s = await seedTenant(); const c = await user();
    const o = await makeOrder(c, s, 3);
    await c.req('POST', `/orders/${o.orderId}/checkout`);
    const info = sim.checkoutFor(o.orderId)!;
    expect(info).toMatchObject({
      orderNumber: 1, totalCents: 3 * 420000, currency: 'ARS', items: [{ title: 'Rubia Lager', quantity: 3, unitPriceCents: 420000 }],
      notificationUrl: `${API}/webhooks/mercadopago`,
      backUrls: { success: `${ORIGIN}/orders/${o.orderId}?pago=ok`, failure: `${ORIGIN}/orders/${o.orderId}?pago=error`, pending: `${ORIGIN}/orders/${o.orderId}?pago=pendiente` },
    });
    const placed = new Date((await one('SELECT placed_at FROM orders WHERE id=$1', [o.orderId])).placed_at).getTime();
    expect(info.expiresAt.getTime() - placed).toBe(10 * 60_000);     // ventana de pago del local: 10 minutos
  });

  it('un pago rechazado no cierra el pedido: se puede reintentar y pagar', async () => {
    const s = await seedTenant(); const c = await user();
    const o = await makeOrder(c, s);
    await c.req('POST', `/orders/${o.orderId}/checkout`);
    expect((await new Client().req('POST', `/dev/pay/${o.orderId}/reject`)).body.outcome).toBe('processed');
    expect(await state(c, o.orderId)).toMatchObject({ status: 'awaiting_payment', paymentStatus: 'pending' });
    expect((await c.req('POST', `/orders/${o.orderId}/checkout`)).status).toBe(200);     // vuelve a intentar
    await new Client().req('POST', `/dev/pay/${o.orderId}/approve`);
    expect(await state(c, o.orderId)).toMatchObject({ status: 'pending_acceptance', paymentStatus: 'approved' });
  });

  it('pagar dos veces el mismo pedido: el segundo cobro se reembolsa y el pedido no se duplica', async () => {
    const s = await seedTenant(); const c = await user();
    const o = await makeOrder(c, s);
    await c.req('POST', `/orders/${o.orderId}/checkout`);
    await new Client().req('POST', `/dev/pay/${o.orderId}/approve`);
    await new Client().req('POST', `/dev/pay/${o.orderId}/approve`);     // doble clic o segunda pestaña
    expect((await one('SELECT count(*)::int n FROM refunds WHERE tenant_id=$1', [s.id])).n).toBe(1);
    expect((await one('SELECT count(*)::int n FROM orders WHERE tenant_id=$1', [s.id])).n).toBe(1);
    expect(await state(c, o.orderId)).toMatchObject({ status: 'pending_acceptance', paymentStatus: 'approved' });
  });
});

describe('quién y cuándo puede iniciar el cobro', () => {
  it('exige sesión y que el pedido sea propio', async () => {
    const s = await seedTenant(); const owner = await user(); const other = await user();
    const o = await makeOrder(owner, s);
    expect((await new Client().req('POST', `/orders/${o.orderId}/checkout`)).status).toBe(401);
    expect((await other.req('POST', `/orders/${o.orderId}/checkout`)).status).toBe(404);
  });

  it('un pedido ya pagado o cancelado no se puede volver a cobrar', async () => {
    const s = await seedTenant(); const c = await user();
    const paid = await makeOrder(c, s);
    await c.req('POST', `/orders/${paid.orderId}/checkout`);
    await new Client().req('POST', `/dev/pay/${paid.orderId}/approve`);
    expect((await c.req('POST', `/orders/${paid.orderId}/checkout`)).body.code).toBe('ORDER_NOT_PAYABLE');

    const cancelled = await makeOrder(c, s, 1);
    await c.req('POST', `/orders/${cancelled.orderId}/cancel`);
    expect((await c.req('POST', `/orders/${cancelled.orderId}/checkout`)).body.code).toBe('ORDER_NOT_PAYABLE');
  });

  it('vencida la ventana de pago del local, no se puede iniciar el cobro', async () => {
    const s = await seedTenant(); const c = await user();
    const o = await makeOrder(c, s);
    await pg.query("UPDATE orders SET placed_at = now() - interval '11 minutes' WHERE id=$1", [o.orderId]);
    const r = await c.req('POST', `/orders/${o.orderId}/checkout`);
    expect(r).toMatchObject({ status: 409, body: { code: 'PAYMENT_WINDOW_EXPIRED' } });
  });

  it('un local sin cuenta de cobro conectada responde con un error claro', async () => {
    const s = await seedTenant({ account: false }); const c = await user();
    const o = await makeOrder(c, s);
    expect((await c.req('POST', `/orders/${o.orderId}/checkout`)).body.code).toBe('PAYMENT_ACCOUNT_NOT_CONNECTED');
  });
});

describe('seguridad de la página simulada y del webhook', () => {
  it('sin el modo simulado (como en producción) las rutas /dev no existen', async () => {
    const c = new Client();
    expect((await c.req('GET', '/dev/pay/00000000-0000-4000-8000-000000000000', undefined, {}, bare)).status).toBe(404);
    expect((await c.req('POST', '/dev/pay/00000000-0000-4000-8000-000000000000/approve', undefined, {}, bare)).status).toBe(404);
  });

  it('rechaza pedidos desconocidos, resultados inválidos e identificadores mal formados', async () => {
    const c = new Client(); const u = '00000000-0000-4000-8000-000000000000';
    expect((await c.req('GET', `/dev/pay/${u}`)).status).toBe(404);
    expect((await c.req('POST', `/dev/pay/${u}/approve`)).status).toBe(404);
    expect((await c.req('GET', '/dev/pay/no-es-uuid')).status).toBe(400);
    const s = await seedTenant(); const cli = await user(); const o = await makeOrder(cli, s);
    await cli.req('POST', `/orders/${o.orderId}/checkout`);
    expect((await c.req('POST', `/dev/pay/${o.orderId}/regalar`)).status).toBe(422);
  });

  it('el webhook rechaza firmas falsas y no procesa dos veces el mismo evento', async () => {
    const s = await seedTenant(); const c = await user();
    const o = await makeOrder(c, s);
    await c.req('POST', `/orders/${o.orderId}/checkout`);
    const wh = sim.announce({ orderId: o.orderId, amountCents: o.totalCents, status: 'approved', accountId: (await one("SELECT provider_account_id a FROM tenant_payment_accounts WHERE tenant_id=$1", [s.id])).a, secret: SECRET });
    const send = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/webhooks/mercadopago', headers: { 'content-type': 'application/json', ...headers }, payload: wh.rawBody });
    expect((await send({ 'x-simulated-signature': 'falsa' })).statusCode).toBe(401);
    expect(safe((await send(wh.headers)).body)).toEqual({ outcome: 'processed' });
    expect(safe((await send(wh.headers)).body)).toEqual({ outcome: 'duplicate' });
  });
});

describe('adaptador de Mercado Pago: crear el cobro (con respuestas simuladas)', () => {
  const input = {
    orderId: 'ord-1', orderNumber: 7, totalCents: 840020, currency: 'ARS', expiresAt: new Date('2030-01-01T12:10:00.000Z'),
    items: [{ title: 'Rubia Lager', quantity: 2, unitPriceCents: 420010 }],
    notificationUrl: 'https://api.test/webhooks/mercadopago',
    backUrls: { success: 'https://app.test/ok', failure: 'https://app.test/error', pending: 'https://app.test/pending' },
  };
  const run = async (response: Response) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return response; }) as unknown as typeof fetch;
    return { calls, provider: new MercadoPagoProvider({ fetchImpl: f }) };
  };

  it('envía el pedido como referencia externa, importes en pesos, avisos y vencimiento', async () => {
    const { calls, provider } = await run(new Response(JSON.stringify({ id: 'PREF-9', init_point: 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=PREF-9' })));
    const out = await provider.createCheckout('TOKEN', input);
    expect(out).toEqual({ checkoutUrl: 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=PREF-9', providerReference: 'PREF-9' });
    expect(calls[0]?.url).toBe('https://api.mercadopago.com/checkout/preferences');
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer TOKEN');
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).toMatchObject({
      external_reference: 'ord-1', notification_url: 'https://api.test/webhooks/mercadopago', back_urls: input.backUrls, auto_return: 'approved', expires: true,
      items: [{ title: 'Rubia Lager', quantity: 2, unit_price: 4200.1, currency_id: 'ARS' }],
    });
    expect(body.expiration_date_to).toBe('2030-01-01T12:10:00.000+00:00');
  });

  it('falla de forma explícita si el proveedor responde con error o sin dirección de pago', async () => {
    await expect((await run(new Response('x', { status: 400 }))).provider.createCheckout('T', input)).rejects.toThrow(/400/);
    await expect((await run(new Response(JSON.stringify({ id: 'x' })))).provider.createCheckout('T', input)).rejects.toThrow(/init_point/);
  });
});
