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
const seedTenant = async () => {
  const n = ++seq;
  const t = (await one("INSERT INTO tenants (name, slug) VALUES ($1,$2) RETURNING id", ['E' + n, 'st-' + n])).id as string;
  await pg.query('INSERT INTO tenant_settings (tenant_id) VALUES ($1)', [t]);
  return { id: t, slug: 'st-' + n, base: `/venues/st-${n}/staff` };
};
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
async function user(role?: { tenant: string; role: string }, name = 'Persona') {
  const c = new Client(); const email = `sa${++seq}@mail.com`;
  const reg = await c.req('POST', '/auth/register', { email, name, password: 'una-clave-larga', adultDeclared: true });
  await c.req('POST', '/auth/login', { email, password: 'una-clave-larga' });
  if (role) await pg.query('INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)', [role.tenant, reg.body.id, role.role]);
  return { c, id: reg.body.id as string, email };
}

describe('equipo del local', () => {
  it('el dueño ve a su equipo con nombre, correo, rol y estado', async () => {
    const s = await seedTenant(); const owner = await user({ tenant: s.id, role: 'owner' }, 'Ana Dueña'); await user({ tenant: s.id, role: 'manager' }, 'Beto Gerente');
    const list = (await owner.c.req('GET', `${s.base}/members`)).body;
    expect(list).toHaveLength(2);
    expect(list.find((m: Row) => m.role === 'owner')).toMatchObject({ name: 'Ana Dueña', email: owner.email, active: true, userId: owner.id });
  });

  it('suma a una persona registrada por su correo (sin distinguir mayúsculas) y le da acceso de inmediato', async () => {
    const s = await seedTenant(); const owner = await user({ tenant: s.id, role: 'owner' }); const newbie = await user(undefined, 'Nueva');
    expect((await newbie.c.req('GET', `${s.base}/orders`)).status).toBe(403);
    const r = await owner.c.req('POST', `${s.base}/members`, { email: newbie.email.toUpperCase(), role: 'order_operator' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ userId: newbie.id, role: 'order_operator', active: true });
    expect((await newbie.c.req('GET', `${s.base}/orders`)).status).toBe(200);
    expect((await one("SELECT count(*)::int n FROM audit_log WHERE tenant_id=$1 AND action='member.added'", [s.id])).n).toBe(1);
  });

  it.each([
    ['correo sin cuenta', { email: 'nadie@sin-cuenta.com', role: 'manager' }, 404, 'USER_NOT_FOUND'],
    ['correo mal formado', { email: 'no-es-correo', role: 'manager' }, 400, 'VALIDATION'],
    ['rol inventado', { email: 'x@y.com', role: 'jefe' }, 400, 'VALIDATION'],
    ['campo desconocido', { email: 'x@y.com', role: 'manager', extra: 1 }, 400, 'VALIDATION'],
  ])('rechaza: %s', async (_n, body, status, code) => {
    const s = await seedTenant(); const owner = await user({ tenant: s.id, role: 'owner' });
    const r = await owner.c.req('POST', `${s.base}/members`, body);
    expect([r.status, r.body.code]).toEqual([status, code]);
  });

  it('no se puede sumar dos veces a la misma persona ni a una cuenta bloqueada', async () => {
    const s = await seedTenant(); const owner = await user({ tenant: s.id, role: 'owner' }); const p = await user(); const blocked = await user();
    await owner.c.req('POST', `${s.base}/members`, { email: p.email, role: 'manager' });
    expect((await owner.c.req('POST', `${s.base}/members`, { email: p.email, role: 'manager' })).body.code).toBe('MEMBER_ALREADY_EXISTS');
    await pg.query("UPDATE users SET status='blocked' WHERE id=$1", [blocked.id]);
    expect((await owner.c.req('POST', `${s.base}/members`, { email: blocked.email, role: 'manager' })).body.code).toBe('USER_BLOCKED');
  });

  it('cambiar el rol aplica de inmediato; desactivar corta el acceso; reactivar lo devuelve con el rol nuevo', async () => {
    const s = await seedTenant(); const owner = await user({ tenant: s.id, role: 'owner' }); const emp = await user({ tenant: s.id, role: 'order_operator' });
    expect((await emp.c.req('GET', `${s.base}/products`)).status).toBe(403);                              // operador: sin catálogo
    await owner.c.req('PUT', `${s.base}/members/${emp.id}`, { role: 'manager' });
    expect((await emp.c.req('GET', `${s.base}/products`)).status).toBe(200);                              // gerente: con catálogo
    await owner.c.req('PUT', `${s.base}/members/${emp.id}`, { active: false });
    expect((await emp.c.req('GET', `${s.base}/products`)).status).toBe(403);
    expect((await emp.c.req('GET', `${s.base}/orders`)).status).toBe(403);
    const back = await owner.c.req('POST', `${s.base}/members`, { email: emp.email, role: 'pickup_operator' });
    expect(back.body).toMatchObject({ role: 'pickup_operator', active: true });
    expect((await emp.c.req('GET', `${s.base}/orders`)).status).toBe(200);
    expect((await one("SELECT count(*)::int n FROM audit_log WHERE tenant_id=$1 AND action='member.reactivated'", [s.id])).n).toBe(1);
  });
});

describe('invariante: el local siempre conserva un dueño activo', () => {
  it('el único dueño no puede degradarse ni desactivarse', async () => {
    const s = await seedTenant(); const owner = await user({ tenant: s.id, role: 'owner' });
    expect((await owner.c.req('PUT', `${s.base}/members/${owner.id}`, { role: 'manager' })).body.code).toBe('LAST_OWNER');
    expect((await owner.c.req('PUT', `${s.base}/members/${owner.id}`, { active: false })).body.code).toBe('LAST_OWNER');
    expect((await one('SELECT role, active FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2', [s.id, owner.id]))).toMatchObject({ role: 'owner', active: true });
  });

  it('con dos dueños, uno puede salir; el que queda ya no', async () => {
    const s = await seedTenant(); const a = await user({ tenant: s.id, role: 'owner' }); const b = await user({ tenant: s.id, role: 'owner' });
    expect((await a.c.req('PUT', `${s.base}/members/${b.id}`, { role: 'manager' })).body.role).toBe('manager');
    expect((await a.c.req('PUT', `${s.base}/members/${a.id}`, { active: false })).body.code).toBe('LAST_OWNER');
  });

  it('promover a otra persona a dueño habilita la salida del primero', async () => {
    const s = await seedTenant(); const a = await user({ tenant: s.id, role: 'owner' }); const b = await user({ tenant: s.id, role: 'manager' });
    await a.c.req('PUT', `${s.base}/members/${b.id}`, { role: 'owner' });
    expect((await a.c.req('PUT', `${s.base}/members/${a.id}`, { role: 'manager' })).status).toBe(200);
    expect((await b.c.req('GET', `${s.base}/members`)).status).toBe(200);          // b ya es el dueño
  });
});

describe('equipo: permisos y aislamiento entre locales', () => {
  it('solo el dueño administra el equipo; el gerente, los operadores y los clientes no', async () => {
    const s = await seedTenant(); const mgr = await user({ tenant: s.id, role: 'manager' }); const ops = await user({ tenant: s.id, role: 'order_operator' });
    const door = await user({ tenant: s.id, role: 'pickup_operator' }); const customer = await user(); const target = await user({ tenant: s.id, role: 'order_operator' });
    for (const u of [mgr, ops, door, customer]) {
      expect((await u.c.req('GET', `${s.base}/members`)).status).toBe(403);
      expect((await u.c.req('POST', `${s.base}/members`, { email: customer.email, role: 'manager' })).status).toBe(403);
      expect((await u.c.req('PUT', `${s.base}/members/${target.id}`, { role: 'owner' })).status).toBe(403);
    }
    expect((await new Client().req('GET', `${s.base}/members`)).status).toBe(401);
    expect((await one('SELECT role FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2', [s.id, target.id])).role).toBe('order_operator');
  });

  it('un dueño no ve ni toca el equipo de otro local, y su lista no mezcla locales', async () => {
    const a = await seedTenant(); const b = await seedTenant();
    const ownerA = await user({ tenant: a.id, role: 'owner' }); const ownerB = await user({ tenant: b.id, role: 'owner' }); const empB = await user({ tenant: b.id, role: 'manager' });
    expect((await ownerA.c.req('GET', `${b.base}/members`)).status).toBe(403);
    expect((await ownerA.c.req('PUT', `${a.base}/members/${empB.id}`, { active: false })).body.code).toBe('MEMBER_NOT_FOUND');
    // una persona que trabaja en dos locales aparece solo en la lista de cada uno con su rol de ese local
    await pg.query('INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)', [a.id, empB.id, 'pickup_operator']);
    expect((await ownerA.c.req('GET', `${a.base}/members`)).body.find((m: Row) => m.userId === empB.id).role).toBe('pickup_operator');
    expect((await ownerB.c.req('GET', `${b.base}/members`)).body.find((m: Row) => m.userId === empB.id).role).toBe('manager');
    expect((await ownerA.c.req('GET', `${a.base}/members`)).body).toHaveLength(2);
  });
});
