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
  const t = (await one("INSERT INTO tenants (name, slug) VALUES ($1,$2) RETURNING id", ['P' + n, 'pp-' + n])).id as string;
  await pg.query('INSERT INTO tenant_settings (tenant_id) VALUES ($1)', [t]);
  return { id: t, slug: 'pp-' + n };
}
class Client {
  sid: string | undefined;
  async req(method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) {
    const h: Record<string, string> = {};
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
  const c = new Client(); const email = `pp${++seq}@mail.com`;
  const reg = await c.req('POST', '/auth/register', { email, name: 'U', password: 'una-clave-larga', adultDeclared: true });
  await c.req('POST', '/auth/login', { email, password: 'una-clave-larga' });
  if (role) await pg.query('INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)', [role.tenant, reg.body.id, role.role]);
  return { c, id: reg.body.id as string };
}
const defaults = async (tenant: string) => (await pg.query<Row>('SELECT name FROM pickup_points WHERE tenant_id=$1 AND active AND is_default', [tenant])).rows.map((r) => r.name);

describe('puntos de retiro', () => {
  it('el primero es el predeterminado; los siguientes no, salvo que se pida', async () => {
    const s = await seedTenant(); const owner = await user({ tenant: s.id, role: 'owner' });
    const url = `/venues/${s.slug}/staff/pickup-points`;
    expect((await owner.c.req('POST', url, { name: 'Barra 1' })).body).toMatchObject({ name: 'Barra 1', isDefault: true, active: true });
    expect((await owner.c.req('POST', url, { name: 'Punto de comida', description: 'Comidas' })).body).toMatchObject({ isDefault: false, description: 'Comidas' });
    expect(await defaults(s.id)).toEqual(['Barra 1']);
    expect((await owner.c.req('POST', url, { name: 'Barra 2', makeDefault: true })).body.isDefault).toBe(true);
    expect(await defaults(s.id)).toEqual(['Barra 2']);                        // nunca hay dos predeterminados
    expect((await owner.c.req('GET', url)).body.map((p: Row) => p.name)).toEqual(['Barra 1', 'Punto de comida', 'Barra 2']);
  });

  it('cambiar el predeterminado marca otro punto y desmarca el anterior', async () => {
    const s = await seedTenant(); const mgr = await user({ tenant: s.id, role: 'manager' });
    const url = `/venues/${s.slug}/staff/pickup-points`;
    const a = (await mgr.c.req('POST', url, { name: 'A' })).body; const b = (await mgr.c.req('POST', url, { name: 'B' })).body;
    expect((await mgr.c.req('PUT', `${url}/${b.id}`, { isDefault: true })).body.isDefault).toBe(true);
    expect(await defaults(s.id)).toEqual(['B']);
    expect((await mgr.c.req('PUT', `${url}/${b.id}`, { isDefault: false })).body.code).toBe('DEFAULT_POINT_REQUIRED');   // no se puede quedar sin predeterminado
    expect((await mgr.c.req('PUT', `${url}/${a.id}`, { name: 'A renombrado' })).body.name).toBe('A renombrado');
  });

  it('no se puede desactivar el predeterminado; un punto desactivado deja de ser candidato y se puede reactivar', async () => {
    const s = await seedTenant(); const mgr = await user({ tenant: s.id, role: 'manager' });
    const url = `/venues/${s.slug}/staff/pickup-points`;
    const a = (await mgr.c.req('POST', url, { name: 'A' })).body; const b = (await mgr.c.req('POST', url, { name: 'B' })).body;
    expect((await mgr.c.req('PUT', `${url}/${a.id}`, { active: false })).body.code).toBe('DEFAULT_POINT_CANNOT_BE_DEACTIVATED');
    expect((await mgr.c.req('PUT', `${url}/${b.id}`, { active: false })).body).toMatchObject({ active: false, isDefault: false });
    expect((await mgr.c.req('PUT', `${url}/${b.id}`, { active: true })).body.active).toBe(true);
  });

  it('los nombres no se repiten entre puntos activos y el nombre es obligatorio', async () => {
    const s = await seedTenant(); const mgr = await user({ tenant: s.id, role: 'manager' });
    const url = `/venues/${s.slug}/staff/pickup-points`;
    const a = (await mgr.c.req('POST', url, { name: 'Barra' })).body; await mgr.c.req('POST', url, { name: 'Cocina' });
    expect((await mgr.c.req('POST', url, { name: 'barra' })).body.code).toBe('POINT_NAME_TAKEN');
    expect((await mgr.c.req('PUT', `${url}/${a.id}`, { name: 'COCINA' })).body.code).toBe('POINT_NAME_TAKEN');
    expect((await mgr.c.req('POST', url, { name: '   ' })).body.code).toBe('NAME_REQUIRED');
    expect((await mgr.c.req('POST', url, { nombre: 'x' })).status).toBe(400);
  });

  it('queda auditado y los cambios en un local no afectan a otro', async () => {
    const a = await seedTenant(); const b = await seedTenant(); const ownerA = await user({ tenant: a.id, role: 'owner' }); const ownerB = await user({ tenant: b.id, role: 'owner' });
    const pa = (await ownerA.c.req('POST', `/venues/${a.slug}/staff/pickup-points`, { name: 'Barra' })).body;
    await ownerB.c.req('POST', `/venues/${b.slug}/staff/pickup-points`, { name: 'Barra' });         // mismo nombre en otro local: permitido
    expect((await ownerB.c.req('PUT', `/venues/${b.slug}/staff/pickup-points/${pa.id}`, { name: 'Hack' })).body.code).toBe('PICKUP_POINT_NOT_FOUND');
    expect((await one("SELECT count(*)::int n FROM audit_log WHERE tenant_id=$1 AND action='pickup_point.created'", [a.id])).n).toBe(1);
    expect((await ownerA.c.req('GET', `/venues/${a.slug}/staff/pickup-points`)).body).toHaveLength(1);
  });

  it('permisos: solo gerente y dueño; operadores, clientes y otros locales no; sin sesión 401', async () => {
    const a = await seedTenant(); const b = await seedTenant();
    const ops = await user({ tenant: a.id, role: 'order_operator' }); const door = await user({ tenant: a.id, role: 'pickup_operator' });
    const customer = await user(); const ownerB = await user({ tenant: b.id, role: 'owner' });
    for (const u of [ops, door, customer, ownerB]) {
      expect((await u.c.req('GET', `/venues/${a.slug}/staff/pickup-points`)).status).toBe(403);
      expect((await u.c.req('POST', `/venues/${a.slug}/staff/pickup-points`, { name: 'X' })).status).toBe(403);
    }
    expect((await new Client().req('GET', `/venues/${a.slug}/staff/pickup-points`)).status).toBe(401);
  });
});
