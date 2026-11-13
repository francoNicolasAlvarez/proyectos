import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allSql } from '../db/schema.mjs';
import type { Database } from '../src/db';
import { buildApp } from '../src/http/app';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ORIGIN = 'https://app.test';
const APP = 'https://pasamanos.test';
let pg: PGlite; let app: FastifyInstance;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(allSql());
  app = await buildApp({
    db: pg as unknown as Database, pickupSecret: 'p', webhookSecret: 'w', encryptionKey: randomBytes(32), provider: { name: 'mercadopago' } as never,
    allowedOrigins: [ORIGIN], publicApiUrl: 'http://localhost:3000', appBaseUrl: APP, secureCookies: false, dbRole: 'app_runtime', scryptCost: 2 ** 10,
  });
});
afterAll(async () => { await app.close(); });

const one = async (sql: string, p: unknown[] = []) => (await pg.query<Row>(sql, p)).rows[0] as Row;
let seq = 0;
async function seedTenant() {
  const n = ++seq;
  const t = (await one("INSERT INTO tenants (name, slug) VALUES ($1,$2) RETURNING id", ['L' + n, 'loc-' + n])).id as string;
  await pg.query('INSERT INTO tenant_settings (tenant_id) VALUES ($1)', [t]);
  return { id: t, slug: 'loc-' + n };
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
    return { status: res.statusCode, body: json, type: String(res.headers['content-type'] ?? '') };
  }
}
async function user(role?: { tenant: string; role: string }) {
  const c = new Client(); const email = `lo${++seq}@mail.com`;
  const reg = await c.req('POST', '/auth/register', { email, name: 'U', password: 'una-clave-larga', adultDeclared: true });
  await c.req('POST', '/auth/login', { email, password: 'una-clave-larga' });
  if (role) await pg.query('INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)', [role.tenant, reg.body.id, role.role]);
  return { c, id: reg.body.id as string };
}
const tokenOf = (qrUrl: string) => new URL(qrUrl).searchParams.get('s') as string;

describe('sectores y QR', () => {
  it('crear un sector devuelve su QR: una dirección de la app con el sector precargado', async () => {
    const s = await seedTenant(); const mgr = await user({ tenant: s.id, role: 'manager' });
    const r = await mgr.c.req('POST', `/venues/${s.slug}/staff/locations`, { name: '  Mesa 5  ', kind: 'table' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: 'Mesa 5', kind: 'table', active: true });
    expect(r.body.qrUrl).toMatch(new RegExp(`^${APP}/v/${s.slug}\\?s=[a-f0-9]{64}$`));
    expect((await mgr.c.req('GET', `/venues/${s.slug}/staff/locations`)).body.map((l: Row) => l.name)).toEqual(['Mesa 5']);
  });

  it('el QR descargable es una imagen SVG con el código y no se guarda en caché', async () => {
    const s = await seedTenant(); const mgr = await user({ tenant: s.id, role: 'owner' });
    const loc = (await mgr.c.req('POST', `/venues/${s.slug}/staff/locations`, { name: 'Barra principal', kind: 'bar' })).body;
    const svg = await mgr.c.req('GET', `/venues/${s.slug}/staff/locations/${loc.id}/qr.svg`);
    expect(svg.status).toBe(200);
    expect(svg.type).toContain('image/svg+xml');
    expect(String(svg.body)).toMatch(/<svg[\s\S]*<\/svg>/);
  });

  it('el cliente escanea el QR (sin sesión) y obtiene el sector; un QR inválido o inactivo no resuelve', async () => {
    const s = await seedTenant(); const mgr = await user({ tenant: s.id, role: 'manager' });
    const loc = (await mgr.c.req('POST', `/venues/${s.slug}/staff/locations`, { name: 'Sector VIP', kind: 'sector' })).body;
    const token = tokenOf(loc.qrUrl);
    expect((await new Client().req('GET', `/venues/${s.slug}/locations/by-token/${token}`)).body).toEqual({ id: loc.id, name: 'Sector VIP' });
    expect((await new Client().req('GET', `/venues/${s.slug}/locations/by-token/${'0'.repeat(64)}`)).status).toBe(404);
    expect((await new Client().req('GET', `/venues/${s.slug}/locations/by-token/corto`)).status).toBe(400);
    await mgr.c.req('PUT', `/venues/${s.slug}/staff/locations/${loc.id}`, { active: false });
    expect((await new Client().req('GET', `/venues/${s.slug}/locations/by-token/${token}`)).status).toBe(404);
  });

  it('un QR de un local no resuelve en otro local', async () => {
    const a = await seedTenant(); const b = await seedTenant(); const mgrA = await user({ tenant: a.id, role: 'manager' });
    const loc = (await mgrA.c.req('POST', `/venues/${a.slug}/staff/locations`, { name: 'Patio', kind: 'sector' })).body;
    expect((await new Client().req('GET', `/venues/${b.slug}/locations/by-token/${tokenOf(loc.qrUrl)}`)).status).toBe(404);
  });

  it('rotar el QR invalida el anterior y emite uno nuevo; queda auditado', async () => {
    const s = await seedTenant(); const owner = await user({ tenant: s.id, role: 'owner' });
    const loc = (await owner.c.req('POST', `/venues/${s.slug}/staff/locations`, { name: 'Mesa 1', kind: 'table' })).body;
    const old = tokenOf(loc.qrUrl);
    const rotated = (await owner.c.req('POST', `/venues/${s.slug}/staff/locations/${loc.id}/rotate-qr`, {})).body;
    expect(tokenOf(rotated.qrUrl)).not.toBe(old);
    expect((await new Client().req('GET', `/venues/${s.slug}/locations/by-token/${old}`)).status).toBe(404);
    expect((await new Client().req('GET', `/venues/${s.slug}/locations/by-token/${tokenOf(rotated.qrUrl)}`)).status).toBe(200);
    expect((await one("SELECT count(*)::int n FROM audit_log WHERE tenant_id=$1 AND action='location.qr_rotated'", [s.id])).n).toBe(1);
  });

  it('valida nombres: obligatorio, sin repetir entre sectores activos, y renombrar', async () => {
    const s = await seedTenant(); const mgr = await user({ tenant: s.id, role: 'manager' });
    const post = (name: string) => mgr.c.req('POST', `/venues/${s.slug}/staff/locations`, { name, kind: 'table' });
    expect((await post('   ')).body.code).toBe('NAME_REQUIRED');
    const a = (await post('Mesa 7')).body;
    expect((await post('mesa 7')).body.code).toBe('LOCATION_NAME_TAKEN');
    expect((await mgr.c.req('PUT', `/venues/${s.slug}/staff/locations/${a.id}`, { name: 'Mesa 8' })).body.name).toBe('Mesa 8');
    expect((await mgr.c.req('POST', `/venues/${s.slug}/staff/locations`, { name: 'x', kind: 'inventado' })).status).toBe(400);
    expect((await mgr.c.req('PUT', `/venues/${s.slug}/staff/locations/${a.id}`, { nombre: 'x' })).status).toBe(400);
  });

  it('un cliente puede pedir con el sector escaneado como origen, y queda guardado', async () => {
    const s = await seedTenant(); const mgr = await user({ tenant: s.id, role: 'manager' }); const cli = await user();
    await pg.query("INSERT INTO tenant_payment_methods (tenant_id, method, enabled) VALUES ($1,'payment_app',true)", [s.id]);
    await pg.query("INSERT INTO pickup_points (tenant_id, name, is_default) VALUES ($1,'Barra',true)", [s.id]);
    const menu = (await one("INSERT INTO menus (tenant_id, name, is_default) VALUES ($1,'Carta',true) RETURNING id", [s.id])).id;
    const cat = (await one("INSERT INTO categories (tenant_id, menu_id, name) VALUES ($1,$2,'C') RETURNING id", [s.id, menu])).id;
    const beer = (await one("INSERT INTO products (tenant_id, category_id, name, base_price_cents) VALUES ($1,$2,'Rubia',420000) RETURNING id", [s.id, cat])).id;
    const loc = (await mgr.c.req('POST', `/venues/${s.slug}/staff/locations`, { name: 'Mesa 5', kind: 'table' })).body;
    const scanned = (await new Client().req('GET', `/venues/${s.slug}/locations/by-token/${tokenOf(loc.qrUrl)}`)).body;
    const o = await cli.c.req('POST', `/venues/${s.slug}/orders`, { paymentMethod: 'payment_app', originLocationId: scanned.id, items: [{ productId: beer, quantity: 1, selections: {} }] }, { 'idempotency-key': 'loc-origin-' + Date.now() });
    expect(o.status).toBe(201);
    expect((await one('SELECT origin_location_name_snapshot n FROM orders WHERE id=$1', [o.body.orderId])).n).toBe('Mesa 5');
  });
});

describe('permisos', () => {
  it('solo gerente y dueño administran sectores; el resto, no; otro local, tampoco', async () => {
    const a = await seedTenant(); const b = await seedTenant();
    const ops = await user({ tenant: a.id, role: 'order_operator' }); const door = await user({ tenant: a.id, role: 'pickup_operator' });
    const customer = await user(); const ownerB = await user({ tenant: b.id, role: 'owner' });
    const owner = await user({ tenant: a.id, role: 'owner' });
    const loc = (await owner.c.req('POST', `/venues/${a.slug}/staff/locations`, { name: 'Mesa 9', kind: 'table' })).body;
    for (const u of [ops, door, customer, ownerB]) {
      expect((await u.c.req('GET', `/venues/${a.slug}/staff/locations`)).status).toBe(403);
      expect((await u.c.req('POST', `/venues/${a.slug}/staff/locations`, { name: 'Intruso', kind: 'table' })).status).toBe(403);
      expect((await u.c.req('POST', `/venues/${a.slug}/staff/locations/${loc.id}/rotate-qr`, {})).status).toBe(403);
      expect((await u.c.req('GET', `/venues/${a.slug}/staff/locations/${loc.id}/qr.svg`)).status).toBe(403);
    }
    expect((await new Client().req('GET', `/venues/${a.slug}/staff/locations`)).status).toBe(401);
    // el id de un sector de otro local no se puede tocar ni con permisos en el propio
    expect((await ownerB.c.req('POST', `/venues/${b.slug}/staff/locations/${loc.id}/rotate-qr`, {})).body.code).toBe('LOCATION_NOT_FOUND');
  });
});
