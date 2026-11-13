import { randomBytes } from 'node:crypto';
import { allSql } from '../db/schema.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext, type Database } from '../src/db';
import { buildApp } from '../src/http/app';
import { dispatchOutbox } from '../src/notifications';
import { createOrder, markPaymentApproved } from '../src/order-service';
import { InMemoryHub } from '../src/realtime';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ORIGIN = 'https://app.test';
let pg: PGlite; let db: Database; let app: FastifyInstance; let base: string;
const hub = new InMemoryHub();

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(allSql());
  db = pg as unknown as Database;
  app = await buildApp({
    db, hub, pickupSecret: 'p', webhookSecret: 'w', encryptionKey: randomBytes(32),
    provider: { name: 'mercadopago' } as never, allowedOrigins: [ORIGIN], publicApiUrl: 'http://localhost:3000', appBaseUrl: 'http://localhost:5173', secureCookies: false, dbRole: 'app_runtime', scryptCost: 2 ** 10,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});
afterAll(async () => { await app.close(); });

const one = async (sql: string, p: unknown[] = []) => (await pg.query<Row>(sql, p)).rows[0] as Row;
let seq = 0;
async function user() {
  const email = `rt${++seq}@mail.com`;
  const reg = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, name: 'U', password: 'una-clave-larga', adultDeclared: true } });
  const log = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'una-clave-larga' } });
  const sid = /sid=([^;]*)/.exec(String(log.headers['set-cookie']))![1]!;
  return { id: reg.json().id as string, sid };
}

/** Lector de eventos SSE con tiempo límite. */
async function open(path: string, sid?: string) {
  const res = await fetch(base + path, { headers: sid ? { cookie: `sid=${sid}` } : {} });
  if (!res.ok || !res.body) return { status: res.status, next: async () => '', close: async () => undefined };
  const reader = res.body.getReader(); const dec = new TextDecoder();
  return {
    status: res.status,
    next: async (ms = 1500) => {
      const t = new Promise<string>((r) => setTimeout(() => r('__timeout__'), ms));
      const read = reader.read().then((x) => (x.done ? '__closed__' : dec.decode(x.value)));
      return Promise.race([read, t]);
    },
    close: async () => { await reader.cancel().catch(() => undefined); },
  };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('hub en memoria', () => {
  it('entrega por canal, permite desuscribirse y aísla a los suscriptores fallidos', () => {
    const h = new InMemoryHub(); const got: unknown[] = [];
    const off = h.subscribe('a', (m) => got.push(['1', m]));
    h.subscribe('a', () => { throw new Error('roto'); });
    h.subscribe('a', (m) => got.push(['3', m]));
    h.subscribe('b', (m) => got.push(['b', m]));
    h.publish('a', { x: 1 });
    expect(got).toEqual([['1', { x: 1 }], ['3', { x: 1 }]]);
    off(); h.publish('a', { x: 2 });
    expect(got).toHaveLength(3);
    expect(h.subscriberCount('a')).toBe(2);
    expect(h.subscriberCount('nadie')).toBe(0);
  });
});

describe('SSE', () => {
  it('el cliente necesita sesión y solo recibe los mensajes de su propio canal', async () => {
    expect((await open('/events')).status).toBe(401);
    const a = await user(); const b = await user();
    const sa = await open('/events', a.sid);
    expect(sa.status).toBe(200);
    expect(await sa.next()).toContain(': conectado');
    hub.publish(`user:${b.id}`, { type: 'ajeno' });
    hub.publish(`user:${a.id}`, { type: 'propio' });
    const msg = await sa.next();
    expect(msg).toContain('"type":"propio"');
    expect(msg).not.toContain('ajeno');
    await sa.close();
    await wait(100);
    expect(hub.subscriberCount(`user:${a.id}`)).toBe(0);   // al cerrar la conexión se libera la suscripción
  });

  it('el canal del local exige rol de personal en ESE local', async () => {
    const t1 = (await one("INSERT INTO tenants (name, slug) VALUES ('A','sse-a') RETURNING id")).id;
    await one("INSERT INTO tenants (name, slug) VALUES ('B','sse-b') RETURNING id");
    const staff = await user(); const customer = await user();
    await pg.query("INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1,$2,'pickup_operator')", [t1, staff.id]);
    expect((await open('/venues/sse-a/staff/events')).status).toBe(401);
    expect((await open('/venues/sse-a/staff/events', customer.sid)).status).toBe(403);
    expect((await open('/venues/sse-b/staff/events', staff.sid)).status).toBe(403);   // personal de otro local
    const s = await open('/venues/sse-a/staff/events', staff.sid);
    expect(s.status).toBe(200);
    await s.next();
    hub.publish(`tenant:${t1}`, { type: 'queue_changed' });
    expect(await s.next()).toContain('queue_changed');
    await s.close();
  });

  it('de punta a punta: el pago aprobado llega en vivo al cliente y al panel del local', async () => {
    const t = (await one("INSERT INTO tenants (name, slug) VALUES ('C','sse-c') RETURNING id")).id;
    const customer = await user(); const staff = await user();
    await pg.query("INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1,$2,'order_operator')", [t, staff.id]);
    await pg.query('INSERT INTO tenant_settings (tenant_id) VALUES ($1)', [t]);
    await pg.query("INSERT INTO tenant_payment_methods (tenant_id, method, enabled) VALUES ($1,'payment_app',true)", [t]);
    await pg.query("INSERT INTO pickup_points (tenant_id, name, is_default) VALUES ($1,'Barra',true)", [t]);
    const menu = (await one("INSERT INTO menus (tenant_id, name, is_default) VALUES ($1,'Carta',true) RETURNING id", [t])).id;
    const cat = (await one("INSERT INTO categories (tenant_id, menu_id, name) VALUES ($1,$2,'C') RETURNING id", [t, menu])).id;
    const product = (await one("INSERT INTO products (tenant_id, category_id, name, base_price_cents) VALUES ($1,$2,'P',100000) RETURNING id", [t, cat])).id;

    const c = await open('/events', customer.sid); const s = await open('/venues/sse-c/staff/events', staff.sid);
    await c.next(); await s.next();

    const o = await withContext(db, { tenantId: t, userId: customer.id, role: 'app_runtime' }, (tx) =>
      createOrder(tx, { tenantId: t, userId: customer.id, idempotencyKey: 'rt-key-1', paymentMethod: 'payment_app', items: [{ productId: product, quantity: 1, selections: {} }] }));
    await withContext(db, { tenantId: t, role: 'app_runtime' }, (tx) =>
      markPaymentApproved(tx, { tenantId: t, orderId: o.orderId, provider: 'mp', providerPaymentId: 'RT-1', amountCents: o.totalCents }));
    await dispatchOutbox(db, hub, { role: 'app_runtime' });

    const forCustomer = await c.next() + await c.next(200).catch(() => '');
    expect(forCustomer).toContain('payment_approved');
    expect(forCustomer).toContain('Pago aprobado');
    const forStaff = await s.next();
    expect(forStaff).toContain('queue_changed');
    expect(forStaff).not.toContain(customer.id);   // el canal del local no lleva datos del cliente
    await c.close(); await s.close();
  });
});
