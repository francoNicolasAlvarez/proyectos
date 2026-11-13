import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allSql } from '../db/schema.mjs';
import type { Database } from '../src/db';
import { buildApp } from '../src/http/app';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ORIGIN = 'https://app.test';
let pg: PGlite; let app: FastifyInstance;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(allSql());
  app = await buildApp({
    db: pg as unknown as Database, pickupSecret: 'p', webhookSecret: 'w', encryptionKey: randomBytes(32), provider: { name: 'mercadopago' } as never,
    allowedOrigins: [ORIGIN], publicApiUrl: 'http://localhost:3000', appBaseUrl: 'http://localhost:5173', secureCookies: false, dbRole: 'app_runtime', scryptCost: 2 ** 10,
  });
});
afterAll(async () => { await app.close(); });

const one = async (sql: string, p: unknown[] = []) => (await pg.query<Row>(sql, p)).rows[0] as Row;
let seq = 0;

async function seedTenant() {
  const n = ++seq;
  const t = (await one("INSERT INTO tenants (name, slug) VALUES ($1,$2) RETURNING id", ['K' + n, 'cat-' + n])).id as string;
  await pg.query('INSERT INTO tenant_settings (tenant_id) VALUES ($1)', [t]);
  await pg.query("INSERT INTO tenant_payment_methods (tenant_id, method, enabled) VALUES ($1,'payment_app',true)", [t]);
  await pg.query("INSERT INTO pickup_points (tenant_id, name, is_default) VALUES ($1,'Barra',true)", [t]);
  const menu = (await one("INSERT INTO menus (tenant_id, name, is_default) VALUES ($1,'Carta',true) RETURNING id", [t])).id;
  const cat = (await one("INSERT INTO categories (tenant_id, menu_id, name) VALUES ($1,$2,'Cervezas') RETURNING id", [t, menu])).id as string;
  const beer = (await one("INSERT INTO products (tenant_id, category_id, name, base_price_cents) VALUES ($1,$2,'Rubia',420000) RETURNING id", [t, cat])).id as string;
  return { id: t, slug: 'cat-' + n, cat, beer };
}

class Client {
  sid: string | undefined;
  async req(method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { ...headers };
    if (this.sid) h.cookie = `sid=${this.sid}`;
    if (this.sid && method !== 'GET') h.origin = ORIGIN;
    const res = await app.inject({ method, url, headers: h, payload: body as object | undefined });
    const m = /sid=([^;]*)/.exec(String(res.headers['set-cookie'] ?? ''));
    if (m) this.sid = m[1] || undefined;
    let json: any; try { json = JSON.parse(res.body); } catch { json = res.body; } // eslint-disable-line @typescript-eslint/no-explicit-any
    return { status: res.statusCode, body: json };
  }
}
async function user(role?: { tenant: string; role: string }) {
  const c = new Client(); const email = `ca${++seq}@mail.com`;
  const reg = await c.req('POST', '/auth/register', { email, name: 'U', password: 'una-clave-larga', adultDeclared: true });
  await c.req('POST', '/auth/login', { email, password: 'una-clave-larga' });
  if (role) await pg.query('INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)', [role.tenant, reg.body.id, role.role]);
  return { c, id: reg.body.id as string };
}
let k = 0;
const orderBeer = (c: Client, s: { slug: string; beer: string }) =>
  c.req('POST', `/venues/${s.slug}/orders`, { paymentMethod: 'payment_app', items: [{ productId: s.beer, quantity: 1, selections: {} }] }, { 'idempotency-key': 'ca-key-' + ++k });
const menuOf = async (s: { slug: string }) => (await new Client().req('GET', `/venues/${s.slug}/menu`)).body;

describe('agotar y reactivar productos', () => {
  it('el producto agotado se ve así en el menú y no se puede pedir; al reactivarlo vuelve todo', async () => {
    const s = await seedTenant(); const ops = await user({ tenant: s.id, role: 'order_operator' }); const cli = await user();
    const url = `/venues/${s.slug}/staff/products/${s.beer}/availability`;
    expect((await orderBeer(cli.c, s)).status).toBe(201);

    expect((await ops.c.req('PUT', url, { available: false })).body).toEqual({ id: s.beer, name: 'Rubia', available: false });
    expect((await menuOf(s)).categories[0].products[0].available).toBe(false);
    const blocked = await orderBeer(cli.c, s);
    expect(blocked).toMatchObject({ status: 422, body: { code: 'PRODUCT_UNAVAILABLE' } });

    await ops.c.req('PUT', url, { available: true });
    expect((await menuOf(s)).categories[0].products[0].available).toBe(true);
    // el pedido anterior sigue abierto, así que no se puede repetir el mismo de inmediato por límites; basta con ver que ya no lo bloquea la disponibilidad
    expect((await orderBeer(cli.c, s)).body.code).not.toBe('PRODUCT_UNAVAILABLE');
  });

  it('queda auditado con el antes y el después, y repetir el mismo valor no genera ruido', async () => {
    const s = await seedTenant(); const mgr = await user({ tenant: s.id, role: 'manager' });
    const url = `/venues/${s.slug}/staff/products/${s.beer}/availability`;
    await mgr.c.req('PUT', url, { available: false });
    await mgr.c.req('PUT', url, { available: false });                       // mismo valor
    const rows = (await pg.query<Row>("SELECT actor_user_id, before, after FROM audit_log WHERE tenant_id=$1 AND action='product.availability_changed'", [s.id])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_user_id: mgr.id, before: { available: true }, after: { available: false } });
  });

  it('productos inexistentes o de otro local dan 404; el cuerpo se valida', async () => {
    const a = await seedTenant(); const b = await seedTenant(); const opsA = await user({ tenant: a.id, role: 'order_operator' });
    expect((await opsA.c.req('PUT', `/venues/${a.slug}/staff/products/${b.beer}/availability`, { available: false })).body.code).toBe('PRODUCT_NOT_FOUND');
    expect((await opsA.c.req('PUT', `/venues/${a.slug}/staff/products/${a.beer}/availability`, { available: 'no' })).status).toBe(400);
    expect((await opsA.c.req('PUT', `/venues/${a.slug}/staff/products/${a.beer}/availability`, { available: false, precio: 1 })).status).toBe(400);
    expect((await opsA.c.req('PUT', `/venues/${a.slug}/staff/products/no-es-uuid/availability`, { available: false })).status).toBe(400);
    expect((await one('SELECT available FROM products WHERE id=$1', [b.beer])).available).toBe(true);
  });
});

describe('pausar categorías', () => {
  it('una categoría pausada marca sus productos como no disponibles y bloquea pedirlos', async () => {
    const s = await seedTenant(); const ops = await user({ tenant: s.id, role: 'order_operator' }); const cli = await user();
    const url = `/venues/${s.slug}/staff/categories/${s.cat}/pause`;
    expect((await ops.c.req('PUT', url, { paused: true })).body).toEqual({ id: s.cat, name: 'Cervezas', paused: true });
    const m = await menuOf(s);
    expect(m.categories[0]).toMatchObject({ paused: true });
    expect(m.categories[0].products[0].available).toBe(false);
    expect((await orderBeer(cli.c, s)).body.code).toBe('PRODUCT_UNAVAILABLE');
    await ops.c.req('PUT', url, { paused: false });
    expect((await orderBeer(cli.c, s)).status).toBe(201);
  });
});

describe('pausar todos los pedidos del local', () => {
  it('los clientes ven el aviso y no pueden pedir; al reanudar se borra el mensaje', async () => {
    const s = await seedTenant(); const ops = await user({ tenant: s.id, role: 'order_operator' }); const cli = await user();
    const url = `/venues/${s.slug}/staff/ordering`;
    expect((await ops.c.req('PUT', url, { paused: true, message: '  Volvemos en 10 minutos  ' })).body).toEqual({ paused: true, message: 'Volvemos en 10 minutos' });
    expect(await menuOf(s)).toMatchObject({ paused: true, pauseMessage: 'Volvemos en 10 minutos' });
    expect((await orderBeer(cli.c, s)).body.code).toBe('PAUSED');

    expect((await ops.c.req('PUT', url, { paused: false, message: 'ignorado' })).body).toEqual({ paused: false, message: null });
    expect(await menuOf(s)).toMatchObject({ paused: false, pauseMessage: null });
    expect((await orderBeer(cli.c, s)).status).toBe(201);
    expect((await ops.c.req('PUT', url, { paused: true, message: 'x'.repeat(201) })).status).toBe(400);
  });
});

describe('permisos', () => {
  it('el operador de entrega, el cliente y el personal de otro local no pueden; sin sesión 401', async () => {
    const a = await seedTenant(); const b = await seedTenant();
    const door = await user({ tenant: a.id, role: 'pickup_operator' }); const customer = await user(); const ownerB = await user({ tenant: b.id, role: 'owner' });
    for (const [method, path, body] of [
      ['PUT', `/venues/${a.slug}/staff/products/${a.beer}/availability`, { available: false }],
      ['PUT', `/venues/${a.slug}/staff/categories/${a.cat}/pause`, { paused: true }],
      ['PUT', `/venues/${a.slug}/staff/ordering`, { paused: true }],
    ] as const) {
      expect((await door.c.req(method, path, body)).status, `entrega ${path}`).toBe(403);
      expect((await customer.c.req(method, path, body)).status, `cliente ${path}`).toBe(403);
      expect((await ownerB.c.req(method, path, body)).status, `otro local ${path}`).toBe(403);
      expect((await new Client().req(method, path, body)).status, `sin sesión ${path}`).toBe(401);
    }
    expect((await one('SELECT ordering_paused FROM tenant_settings WHERE tenant_id=$1', [a.id])).ordering_paused).toBe(false);
  });
});
