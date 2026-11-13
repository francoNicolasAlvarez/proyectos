import { randomBytes } from 'node:crypto';
import { allSql } from '../db/schema.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptSecret } from '../src/crypto-box';
import type { Database } from '../src/db';
import { buildApp } from '../src/http/app';
import type { PaymentProvider, ProviderPayment, WebhookRequest } from '../src/payments/provider';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ORIGIN = 'https://app.test';
const KEY = randomBytes(32);
let pg: PGlite;
let app: FastifyInstance;

class FakeProvider implements PaymentProvider {
  readonly name = 'mercadopago';
  async createCheckout() { return { checkoutUrl: 'https://pago.fake/checkout', providerReference: null }; }
  payments = new Map<string, ProviderPayment>();
  verifyWebhookSignature(req: WebhookRequest) { return req.headers['x-signature'] === 'ok'; }
  parseWebhook(req: WebhookRequest) { const b = JSON.parse(req.rawBody); return { eventId: String(b.id), type: 'payment' as const, resourceId: String(b.data.id), accountId: String(b.user_id) }; }
  async getPayment(_t: string, id: string) { const p = this.payments.get(id); if (!p) throw new Error('x'); return p; }
  async refund() { return { refundId: 'R' }; }
}
const provider = new FakeProvider();

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(allSql());
  app = await buildApp({
    db: pg as unknown as Database, pickupSecret: 'pick', webhookSecret: 'wh', encryptionKey: KEY, provider,
    allowedOrigins: [ORIGIN], publicApiUrl: 'http://localhost:3000', appBaseUrl: 'http://localhost:5173', secureCookies: false, dbRole: 'app_runtime', scryptCost: 2 ** 10,
  });
});
afterAll(async () => { await app.close(); });

const one = async (sql: string, p: unknown[] = []) => (await pg.query<Row>(sql, p)).rows[0] as Row;

/* ---------- cliente HTTP mínimo con cookies ---------- */
class Client {
  sid: string | undefined;
  async req(method: 'GET' | 'POST', url: string, body?: unknown, headers: Record<string, string> = {}, opts: { origin?: string | null } = {}) {
    const h: Record<string, string> = { ...headers };
    if (this.sid) h.cookie = `sid=${this.sid}`;
    if (this.sid && method === 'POST' && opts.origin !== null) h.origin = opts.origin ?? ORIGIN;
    const res = await app.inject({ method, url, headers: h, payload: body === undefined ? undefined : (body as object) });
    const set = res.headers['set-cookie'];
    const raw = Array.isArray(set) ? set[0] : set;
    const m = /sid=([^;]*)/.exec(raw ?? '');
    if (m) this.sid = m[1] || undefined;
    return { status: res.statusCode, body: res.body ? safe(res.body) : null, raw };
  }
}
const safe = (s: string) => { try { return JSON.parse(s); } catch { return s; } };

let seq = 0;
async function newUser(c = new Client(), over: Record<string, unknown> = {}) {
  const email = `h${++seq}@mail.com`;
  const reg = await c.req('POST', '/auth/register', { email, name: 'Ana', password: 'una-clave-larga', adultDeclared: true, ...over });
  const log = await c.req('POST', '/auth/login', { email, password: 'una-clave-larga' });
  return { c, id: reg.body.id as string, email, login: log };
}

interface Seed { id: string; slug: string; beer: string; size: { group: string; pint: string }; point: string; accountId: string }
async function seedTenant(): Promise<Seed> {
  const n = ++seq;
  const slug = 'http-bar-' + n;
  const t = (await one("INSERT INTO tenants (name, slug) VALUES ($1,$2) RETURNING id", ['Bar ' + n, slug])).id;
  await pg.query('INSERT INTO tenant_settings (tenant_id) VALUES ($1)', [t]);
  await pg.query("INSERT INTO tenant_payment_methods (tenant_id, method, enabled) VALUES ($1,'payment_app',true)", [t]);
  const point = (await one("INSERT INTO pickup_points (tenant_id, name, is_default) VALUES ($1,'Barra 1',true) RETURNING id", [t])).id;
  const menu = (await one("INSERT INTO menus (tenant_id, name, is_default) VALUES ($1,'Carta',true) RETURNING id", [t])).id;
  const cat = (await one("INSERT INTO categories (tenant_id, menu_id, name) VALUES ($1,$2,'Cervezas') RETURNING id", [t, menu])).id;
  const beer = (await one("INSERT INTO products (tenant_id, category_id, name, base_price_cents, prep_minutes) VALUES ($1,$2,'Rubia',420000,2) RETURNING id", [t, cat])).id;
  const g = (await one("INSERT INTO option_groups (tenant_id, product_id, name, min_select, max_select) VALUES ($1,$2,'Tamaño',1,1) RETURNING id", [t, beer])).id;
  const pint = (await one("INSERT INTO options (tenant_id, group_id, name, price_delta_cents) VALUES ($1,$2,'Pinta',0) RETURNING id", [t, g])).id;
  const accountId = 'ACC-' + n;
  await pg.query("INSERT INTO tenant_payment_accounts (tenant_id, provider, provider_account_id, access_token_enc) VALUES ($1,'mercadopago',$2,$3)", [t, accountId, encryptSecret('tok', KEY)]);
  return { id: t, slug, beer, size: { group: g, pint }, point, accountId };
}
const addStaff = async (s: Seed, role: string) => {
  const u = await newUser();
  await pg.query('INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)', [s.id, u.id, role]);
  return u;
};
const orderBody = (s: Seed, extra: Record<string, unknown> = {}) => ({ paymentMethod: 'payment_app', items: [{ productId: s.beer, quantity: 1, selections: { [s.size.group]: [s.size.pint] } }], ...extra });
let k = 0;
const idem = () => ({ 'idempotency-key': 'http-key-' + ++k });
const webhook = async (s: Seed, orderId: string, amount: number, signature = 'ok') => {
  const pid = 'PAY-' + ++k;
  provider.payments.set(pid, { id: pid, status: 'approved', amountCents: amount, currency: 'ARS', externalReference: orderId });
  const res = await app.inject({ method: 'POST', url: '/webhooks/mercadopago', headers: { 'x-signature': signature, 'content-type': 'application/json' },
    payload: JSON.stringify({ id: 'EV-' + pid, type: 'payment', user_id: s.accountId, data: { id: pid } }) });
  return { status: res.statusCode, body: safe(res.body) };
};

describe('cuenta y sesión', () => {
  it('registra, inicia sesión con cookie httpOnly y devuelve al usuario', async () => {
    const u = await newUser();
    expect(u.login.status).toBe(200);
    expect(u.login.raw).toMatch(/HttpOnly/i);
    expect(u.login.raw).toMatch(/SameSite=Lax/i);
    expect((await u.c.req('GET', '/me')).body).toMatchObject({ id: u.id, isPlatformAdmin: false });
  });

  it('cerrar sesión la invalida', async () => {
    const u = await newUser();
    const old = u.c.sid;
    expect((await u.c.req('POST', '/auth/logout')).status).toBe(204);
    const c2 = new Client(); c2.sid = old;
    expect((await c2.req('GET', '/me')).status).toBe(401);
  });

  it('valida la entrada: 400 con detalle, 422 por reglas de negocio', async () => {
    const c = new Client();
    const bad = await c.req('POST', '/auth/register', { email: 1 });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION');
    expect((await c.req('POST', '/auth/register', { email: 'a@b.co', name: 'x', password: 'corta', adultDeclared: true })).body.code).toBe('PASSWORD_TOO_SHORT');
    expect((await c.req('POST', '/auth/register', { email: 'a@b.co', name: 'x', password: 'una-clave-larga', adultDeclared: false })).status).toBe(422);
  });

  it('email repetido → 409; JSON malformado → 400', async () => {
    const u = await newUser();
    expect((await new Client().req('POST', '/auth/register', { email: u.email, name: 'x', password: 'una-clave-larga', adultDeclared: true })).status).toBe(409);
    const res = await app.inject({ method: 'POST', url: '/auth/login', headers: { 'content-type': 'application/json' }, payload: '{roto' });
    expect(res.statusCode).toBe(400);
  });

  it('limita los intentos de login fallidos y luego bloquea incluso con la clave correcta', async () => {
    const u = await newUser();
    const c = new Client();
    for (let i = 0; i < 8; i++) expect((await c.req('POST', '/auth/login', { email: u.email, password: 'incorrecta-1' })).status).toBe(401);
    expect((await c.req('POST', '/auth/login', { email: u.email, password: 'una-clave-larga' })).status).toBe(429);
  });

  it('sin sesión no se accede a rutas privadas', async () => {
    const c = new Client();
    for (const url of ['/me', '/notifications']) expect((await c.req('GET', url)).status).toBe(401);
  });
});

describe('menú y pedidos del cliente', () => {
  it('el menú es público y un local inexistente da 404', async () => {
    const s = await seedTenant();
    const r = await new Client().req('GET', `/venues/${s.slug}/menu`);
    expect(r.status).toBe(200);
    expect(r.body.categories[0].products[0]).toMatchObject({ name: 'Rubia', priceCents: 420000 });
    expect((await new Client().req('GET', '/venues/no-existe/menu')).status).toBe(404);
  });

  it('crear pedido exige sesión, clave de idempotencia y origen permitido', async () => {
    const s = await seedTenant(); const u = await newUser();
    expect((await new Client().req('POST', `/venues/${s.slug}/orders`, orderBody(s), idem())).status).toBe(401);
    expect((await u.c.req('POST', `/venues/${s.slug}/orders`, orderBody(s))).body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    // CSRF: con cookie, sin origen o con origen ajeno se rechaza
    expect((await u.c.req('POST', `/venues/${s.slug}/orders`, orderBody(s), idem(), { origin: null })).status).toBe(403);
    expect((await u.c.req('POST', `/venues/${s.slug}/orders`, orderBody(s), idem(), { origin: 'https://malo.test' })).status).toBe(403);
    expect((await u.c.req('POST', `/venues/${s.slug}/orders`, orderBody(s), idem())).status).toBe(201);
  });

  it('es idempotente (200 con el mismo pedido) y traduce errores de precio a 422', async () => {
    const s = await seedTenant(); const u = await newUser();
    const h = idem();
    const a = await u.c.req('POST', `/venues/${s.slug}/orders`, orderBody(s), h);
    const b = await u.c.req('POST', `/venues/${s.slug}/orders`, orderBody(s), h);
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body.orderId).toBe(a.body.orderId);
    const bad = await u.c.req('POST', `/venues/${s.slug}/orders`, { paymentMethod: 'payment_app', items: [{ productId: s.beer, quantity: 1, selections: {} }] }, idem());
    expect(bad).toMatchObject({ status: 422, body: { code: 'SELECTION_BELOW_MIN' } });
    expect((await u.c.req('POST', `/venues/${s.slug}/orders`, orderBody(s, { paymentMethod: 'cash_on_pickup' }), idem())).status).toBe(400);
  });

  it('el menú informa los límites por pedido y el tipo de cada producto', async () => {
    const s = await seedTenant();
    const r = await new Client().req('GET', `/venues/${s.slug}/menu`);
    expect(r.body.limits).toEqual({ maxTotalCents: 10_000_000, maxIndividualItems: 20, maxCombos: 8 });
    expect(r.body.categories[0].products[0].kind).toBe('simple');
  });

  it('un pedido que supera el límite de gasto o de cantidad responde 422 con el detalle y no se crea', async () => {
    const s = await seedTenant(); const u = await newUser();
    const lines = (q: number) => ({ paymentMethod: 'payment_app', items: [{ productId: s.beer, quantity: q, selections: { [s.size.group]: [s.size.pint] } }] });
    // 25 cervezas × $4.200 = $105.000: supera el gasto y también las 20 unidades
    const both = await u.c.req('POST', `/venues/${s.slug}/orders`, lines(25), idem());
    expect(both.status).toBe(422);
    expect(both.body.code).toBe('ORDER_TOTAL_LIMIT_EXCEEDED');
    expect(both.body.violations).toEqual([
      { code: 'ORDER_TOTAL_LIMIT_EXCEEDED', limit: 10_000_000, actual: 10_500_000 },
      { code: 'ORDER_ITEM_LIMIT_EXCEEDED', limit: 20, actual: 25 },
    ]);
    expect(both.body.usage).toMatchObject({ individualItems: 25, combos: 0, totalCents: 10_500_000 });
    // 21 cervezas = $88.200: solo supera la cantidad
    const items = await u.c.req('POST', `/venues/${s.slug}/orders`, lines(21), idem());
    expect(items.body.violations.map((v: Row) => v.code)).toEqual(['ORDER_ITEM_LIMIT_EXCEEDED']);
    expect((await one('SELECT count(*)::int n FROM orders WHERE tenant_id=$1', [s.id])).n).toBe(0);
    // 20 cervezas = $84.000: permitido
    expect((await u.c.req('POST', `/venues/${s.slug}/orders`, lines(20), idem())).status).toBe(201);
  });

  it('un cliente ve solo sus pedidos: otro recibe 404, un id inválido 400', async () => {
    const s = await seedTenant(); const a = await newUser(); const b = await newUser();
    const o = await a.c.req('POST', `/venues/${s.slug}/orders`, orderBody(s), idem());
    expect((await a.c.req('GET', `/orders/${o.body.orderId}`)).body).toMatchObject({ number: 1, status: 'awaiting_payment' });
    expect((await b.c.req('GET', `/orders/${o.body.orderId}`)).status).toBe(404);
    expect((await b.c.req('POST', `/orders/${o.body.orderId}/cancel`)).status).toBe(404);
    expect((await a.c.req('GET', '/orders/no-es-uuid')).status).toBe(400);
  });

  it('el cliente puede cancelar antes de la aceptación pero no después', async () => {
    const s = await seedTenant(); const u = await newUser(); const mgr = await addStaff(s, 'manager');
    const a = await u.c.req('POST', `/venues/${s.slug}/orders`, orderBody(s), idem());
    expect((await u.c.req('POST', `/orders/${a.body.orderId}/cancel`)).status).toBe(200);

    const b = await u.c.req('POST', `/venues/${s.slug}/orders`, orderBody(s), idem());
    await webhook(s, b.body.orderId, b.body.totalCents);
    expect((await mgr.c.req('POST', `/venues/${s.slug}/staff/orders/${b.body.orderId}/accept`, {})).status).toBe(200);
    expect((await u.c.req('POST', `/orders/${b.body.orderId}/cancel`)).body.code).toBe('INVALID_TRANSITION');
  });
});

describe('personal del local y permisos', () => {
  it('un cliente común no accede a rutas del personal; tampoco el personal de otro local', async () => {
    const a = await seedTenant(); const b = await seedTenant();
    const customer = await newUser(); const staffB = await addStaff(b, 'owner');
    expect((await customer.c.req('GET', `/venues/${a.slug}/staff/orders`)).status).toBe(403);
    expect((await staffB.c.req('GET', `/venues/${a.slug}/staff/orders`)).status).toBe(403);
    expect((await new Client().req('GET', `/venues/${a.slug}/staff/orders`)).status).toBe(401);
    expect((await staffB.c.req('GET', `/venues/${b.slug}/staff/orders`)).status).toBe(200);
  });

  it('cada rol hace solo lo suyo: el operador de entrega no acepta; el de pedidos sí', async () => {
    const s = await seedTenant(); const u = await newUser();
    const pickup = await addStaff(s, 'pickup_operator'); const orders = await addStaff(s, 'order_operator');
    const o = await u.c.req('POST', `/venues/${s.slug}/orders`, orderBody(s), idem());
    await webhook(s, o.body.orderId, o.body.totalCents);
    const url = `/venues/${s.slug}/staff/orders/${o.body.orderId}/accept`;
    expect((await pickup.c.req('POST', url, {})).status).toBe(403);
    expect((await orders.c.req('POST', url, {})).status).toBe(200);
    expect((await pickup.c.req('GET', `/venues/${s.slug}/staff/orders`)).status).toBe(200);
  });

  it('el super admin opera en cualquier local', async () => {
    const s = await seedTenant(); const admin = await newUser();
    await pg.query('UPDATE users SET is_platform_admin = true WHERE id=$1', [admin.id]);
    expect((await admin.c.req('GET', `/venues/${s.slug}/staff/orders`)).status).toBe(200);
  });

  it('rechazar exige un motivo válido y avisa al cliente', async () => {
    const s = await seedTenant(); const u = await newUser(); const mgr = await addStaff(s, 'manager');
    const o = await u.c.req('POST', `/venues/${s.slug}/orders`, orderBody(s), idem());
    await webhook(s, o.body.orderId, o.body.totalCents);
    const url = `/venues/${s.slug}/staff/orders/${o.body.orderId}/reject`;
    expect((await mgr.c.req('POST', url, {})).status).toBe(400);
    expect((await mgr.c.req('POST', url, { reasonCode: 'inventado' })).status).toBe(400);
    const ok = await mgr.c.req('POST', url, { reasonCode: 'out_of_stock' });
    expect(ok).toMatchObject({ status: 200, body: { refundRequested: true } });
    expect((await u.c.req('GET', `/orders/${o.body.orderId}`)).body).toMatchObject({ status: 'rejected', paymentStatus: 'refund_pending', cancelReason: 'out_of_stock' });
  });
});

describe('ciclo completo por HTTP', () => {
  it('pedir, pagar por webhook, aceptar, preparar, marcar listo, ver el QR y retirar', async () => {
    const s = await seedTenant(); const u = await newUser(); const mgr = await addStaff(s, 'manager'); const door = await addStaff(s, 'pickup_operator');

    const created = await u.c.req('POST', `/venues/${s.slug}/orders`, orderBody(s), idem());
    expect(created.status).toBe(201);
    const id = created.body.orderId as string;
    expect((await webhook(s, id, created.body.totalCents)).body).toEqual({ outcome: 'processed' });

    const queue = await mgr.c.req('GET', `/venues/${s.slug}/staff/orders`);
    expect(queue.body).toHaveLength(1);
    expect(queue.body[0]).toMatchObject({ id, status: 'pending_acceptance' });
    expect(JSON.stringify(queue.body)).not.toContain(u.id);   // la cola no expone el id del cliente

    const base = `/venues/${s.slug}/staff`;
    expect((await mgr.c.req('POST', `${base}/orders/${id}/accept`, { etaMinutes: 9 })).status).toBe(200);
    expect((await u.c.req('GET', `/orders/${id}`)).body.status).toBe('accepted');
    expect((await mgr.c.req('POST', `${base}/orders/${id}/prepare`, {})).status).toBe(200);

    const partId = (await one('SELECT id FROM order_parts WHERE order_id=$1', [id])).id;
    const ready = await mgr.c.req('POST', `${base}/parts/${partId}/ready`, { pickupPointId: s.point });
    expect(ready).toMatchObject({ status: 200, body: { orderReady: true } });
    expect(JSON.stringify(ready.body)).not.toMatch(/token|shortCode/i);   // el QR no se le devuelve al personal

    const view = (await u.c.req('GET', `/orders/${id}`)).body;
    expect(view).toMatchObject({ status: 'ready' });
    expect(view.parts[0]).toMatchObject({ pickupPoint: 'Barra 1' });
    const { token, shortCode } = view.parts[0].pickup;

    expect((await door.c.req('POST', `${base}/pickup/redeem`, { shortCode: 'ZZZZ' })).body.code).toBe('INVALID_CODE');
    const done = await door.c.req('POST', `${base}/pickup/redeem`, { token });
    expect(done).toMatchObject({ status: 200, body: { orderDelivered: true, orderNumber: 1 } });
    expect((await door.c.req('POST', `${base}/pickup/redeem`, { shortCode })).body.code).toBe('ALREADY_USED');
    expect((await u.c.req('GET', `/orders/${id}`)).body.status).toBe('delivered');
  });
});

describe('webhook', () => {
  it('rechaza firmas inválidas (401) y cuentas desconocidas (404) sin necesitar sesión', async () => {
    const s = await seedTenant();
    expect((await webhook(s, '00000000-0000-0000-0000-000000000000', 1, 'forjada')).status).toBe(401);
    expect((await webhook({ ...s, accountId: 'NADIE' }, '00000000-0000-0000-0000-000000000000', 1)).status).toBe(404);
  });
});

describe('notificaciones por HTTP', () => {
  it('lista y marca como leídas las notificaciones propias', async () => {
    const s = await seedTenant(); const u = await newUser();
    const o = await u.c.req('POST', `/venues/${s.slug}/orders`, orderBody(s), idem());
    await webhook(s, o.body.orderId, o.body.totalCents);
    const { dispatchOutbox } = await import('../src/notifications');
    await dispatchOutbox(pg as unknown as Database, null, { role: 'app_runtime' });
    const list = await u.c.req('GET', '/notifications');
    expect(list.body.map((n: Row) => n.type)).toEqual(['order_received', 'payment_approved']);
    expect((await u.c.req('POST', '/notifications/read', {})).body).toEqual({ updated: 2 });
    expect((await u.c.req('GET', '/notifications?unread=1')).body).toEqual([]);
  });
});

describe('errores internos', () => {
  it('no filtran detalles: un fallo inesperado responde 500 genérico', async () => {
    const s = await seedTenant(); const u = await newUser();
    await pg.query('ALTER TABLE tenant_settings RENAME TO tenant_settings_x');
    try {
      const r = await u.c.req('POST', `/venues/${s.slug}/orders`, orderBody(s), idem());
      expect(r.status).toBe(500);
      expect(r.body).toEqual({ code: 'INTERNAL' });
    } finally { await pg.query('ALTER TABLE tenant_settings_x RENAME TO tenant_settings'); }
  });
});
