import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext, type Database } from '../src/db';
import { buildApp } from '../src/http/app';
import { confirmLimitsReviewed, getLimitsReport, updateLimits } from '../src/limits-service';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ORIGIN = 'https://app.test';
let pg: PGlite; let db: Database; let app: FastifyInstance;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync(fileURLToPath(new URL('../db/migrations/0001_init.sql', import.meta.url)), 'utf8'));
  db = pg as unknown as Database;
  app = await buildApp({
    db, pickupSecret: 'p', webhookSecret: 'w', encryptionKey: randomBytes(32), provider: { name: 'mercadopago' } as never,
    allowedOrigins: [ORIGIN], secureCookies: false, dbRole: 'app_runtime', scryptCost: 2 ** 10,
  });
});
afterAll(async () => { await app.close(); });

const one = async (sql: string, p: unknown[] = []) => (await pg.query<Row>(sql, p)).rows[0] as Row;
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code?: string }).code ?? (e as Error).message; } return null; };
let seq = 0;

async function seedTenant(extra: { combo?: number; simple?: number } = {}) {
  const n = ++seq;
  const t = (await one("INSERT INTO tenants (name, slug) VALUES ($1,$2) RETURNING id", ['L' + n, 'lim-' + n])).id as string;
  await pg.query('INSERT INTO tenant_settings (tenant_id) VALUES ($1)', [t]);
  const menu = (await one("INSERT INTO menus (tenant_id, name, is_default) VALUES ($1,'Carta',true) RETURNING id", [t])).id;
  const cat = (await one("INSERT INTO categories (tenant_id, menu_id, name) VALUES ($1,$2,'Todo') RETURNING id", [t, menu])).id;
  const add = (name: string, price: number, kind: string, extraSql = '') =>
    pg.query(`INSERT INTO products (tenant_id, category_id, name, base_price_cents, kind${extraSql ? ', ' + extraSql.split('=')[0] : ''}) VALUES ($1,$2,$3,$4,$5${extraSql ? ', ' + extraSql.split('=')[1] : ''})`, [t, cat, name, price, kind]);
  await add('Pinta', extra.simple ?? 420_000, 'simple');
  await add('Combo 3', extra.combo ?? 1_290_000, 'combo');
  return { id: t, slug: 'lim-' + n };
}
const asTenant = (id: string) => ({ tenantId: id, role: 'app_runtime' });
const actor = async () => (await one("INSERT INTO users (email, name) VALUES ($1,'A') RETURNING id", [`la${++seq}@x.com`])).id as string;

describe('informe de límites', () => {
  it('trae los valores por defecto y avisa que con un combo de $12.900 no se llegan a 8 combos', async () => {
    const s = await seedTenant();
    const r = await withContext(db, asTenant(s.id), (tx) => getLimitsReport(tx, s.id));
    expect(r.limits).toEqual({ maxTotalCents: 10_000_000, maxIndividualItems: 20, maxCombos: 8, maxTotalOnPickupCents: 3_000_000, paymentWindowMinutes: 10 });
    expect(r.issues).toEqual([{ code: 'COMBO_LIMIT_UNREACHABLE', severity: 'warning', product: 'Combo 3', maxReachable: 7 }]);
    expect(r.reviewDue).toBe(false);
  });

  it('un catálogo coherente no genera avisos; los productos archivados o agotados no cuentan', async () => {
    const s = await seedTenant({ combo: 1_000_000 });
    await pg.query("INSERT INTO products (tenant_id, category_id, name, base_price_cents, kind, archived_at) VALUES ($1,(SELECT id FROM categories WHERE tenant_id=$1),'Viejo combo',9000000,'combo', now())", [s.id]);
    await pg.query("INSERT INTO products (tenant_id, category_id, name, base_price_cents, kind, available) VALUES ($1,(SELECT id FROM categories WHERE tenant_id=$1),'Agotado',9000000,'combo', false)", [s.id]);
    expect((await withContext(db, asTenant(s.id), (tx) => getLimitsReport(tx, s.id))).issues).toEqual([]);
  });

  it('avisa cuando pasaron más de 60 días sin revisar los topes (inflación)', async () => {
    const s = await seedTenant();
    await pg.query("UPDATE tenant_settings SET limits_reviewed_at = now() - interval '90 days' WHERE tenant_id=$1", [s.id]);
    expect((await withContext(db, asTenant(s.id), (tx) => getLimitsReport(tx, s.id))).reviewDue).toBe(true);
    await pg.query("UPDATE tenant_settings SET limits_reviewed_at = now() - interval '30 days' WHERE tenant_id=$1", [s.id]);
    expect((await withContext(db, asTenant(s.id), (tx) => getLimitsReport(tx, s.id))).reviewDue).toBe(false);
  });
});

describe('cambiar los límites', () => {
  it('actualiza, resuelve el aviso, reinicia la revisión y deja auditoría con el antes y el después', async () => {
    const s = await seedTenant(); const who = await actor();
    await pg.query("UPDATE tenant_settings SET limits_reviewed_at = now() - interval '90 days' WHERE tenant_id=$1", [s.id]);
    const r = await withContext(db, asTenant(s.id), (tx) => updateLimits(tx, { tenantId: s.id, actorUserId: who, changes: { maxTotalCents: 12_000_000 } }));
    expect(r.limits.maxTotalCents).toBe(12_000_000);
    expect(r.limits.maxIndividualItems).toBe(20);               // lo no indicado no cambia
    expect(r.issues).toEqual([]);                                // 8 × $12.900 = $103.200 ya cabe en $120.000
    expect(r.reviewDue).toBe(false);
    const log = await one("SELECT actor_user_id, before, after FROM audit_log WHERE tenant_id=$1 AND action='limits.updated'", [s.id]);
    expect(log.actor_user_id).toBe(who);
    expect(log.before.maxTotalCents).toBe(10_000_000);
    expect(log.after.maxTotalCents).toBe(12_000_000);
  });

  it.each([
    ['cero', { maxTotalCents: 0 }], ['negativo', { maxCombos: -1 }], ['decimal', { maxIndividualItems: 2.5 }],
    ['demasiado grande', { maxIndividualItems: 501 }], ['ventana de pago fuera de rango', { paymentWindowMinutes: 61 }], ['ventana cero', { paymentWindowMinutes: 0 }],
  ])('rechaza valores inválidos: %s', async (_n, changes) => {
    const s = await seedTenant(); const who = await actor();
    expect(await code(withContext(db, asTenant(s.id), (tx) => updateLimits(tx, { tenantId: s.id, actorUserId: who, changes })))).toBe('INVALID_LIMITS');
    expect((await one('SELECT max_order_total_cents FROM tenant_settings WHERE tenant_id=$1', [s.id])).max_order_total_cents).toBe(10_000_000);
    expect((await one("SELECT count(*)::int n FROM audit_log WHERE tenant_id=$1", [s.id])).n).toBe(0);   // un cambio rechazado no deja rastro
  });

  it('confirmar que siguen vigentes reinicia la revisión sin cambiar valores y se audita', async () => {
    const s = await seedTenant(); const who = await actor();
    await pg.query("UPDATE tenant_settings SET limits_reviewed_at = now() - interval '90 days' WHERE tenant_id=$1", [s.id]);
    const r = await withContext(db, asTenant(s.id), (tx) => confirmLimitsReviewed(tx, { tenantId: s.id, actorUserId: who }));
    expect(r.reviewDue).toBe(false);
    expect(r.limits.maxTotalCents).toBe(10_000_000);
    expect((await one("SELECT count(*)::int n FROM audit_log WHERE tenant_id=$1 AND action='limits.reviewed'", [s.id])).n).toBe(1);
  });

  it('un local no puede cambiar los límites de otro', async () => {
    const a = await seedTenant(); const b = await seedTenant(); const who = await actor();
    expect(await code(withContext(db, asTenant(b.id), (tx) => updateLimits(tx, { tenantId: a.id, actorUserId: who, changes: { maxTotalCents: 99_999_999 } })))).toBe('TENANT_NOT_CONFIGURED');
    expect((await one('SELECT max_order_total_cents FROM tenant_settings WHERE tenant_id=$1', [a.id])).max_order_total_cents).toBe(10_000_000);
  });
});

describe('rutas HTTP de límites y permisos', () => {
  class Client {
    sid: string | undefined;
    async req(method: 'GET' | 'PUT' | 'POST', url: string, body?: unknown) {
      const headers: Record<string, string> = {};
      if (this.sid) headers.cookie = `sid=${this.sid}`;
      if (this.sid && method !== 'GET') headers.origin = ORIGIN;
      const res = await app.inject({ method, url, headers, payload: body as object | undefined });
      const m = /sid=([^;]*)/.exec(String(res.headers['set-cookie'] ?? ''));
      if (m) this.sid = m[1] || undefined;
      let json: any; try { json = JSON.parse(res.body); } catch { json = res.body; } // eslint-disable-line @typescript-eslint/no-explicit-any
      return { status: res.statusCode, body: json };
    }
  }
  async function user(role?: { tenant: string; role: string }) {
    const c = new Client(); const email = `lh${++seq}@mail.com`;
    const reg = await c.req('POST', '/auth/register', { email, name: 'U', password: 'una-clave-larga', adultDeclared: true });
    await c.req('POST', '/auth/login', { email, password: 'una-clave-larga' });
    if (role) await pg.query('INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)', [role.tenant, reg.body.id, role.role]);
    return { c, id: reg.body.id as string };
  }

  it('el responsable de catálogo ve el informe; solo el propietario puede cambiar los límites', async () => {
    const s = await seedTenant();
    const owner = await user({ tenant: s.id, role: 'owner' }); const manager = await user({ tenant: s.id, role: 'manager' });
    const ops = await user({ tenant: s.id, role: 'order_operator' }); const customer = await user();
    const url = `/venues/${s.slug}/staff/limits`;

    expect((await manager.c.req('GET', url)).body.issues[0]).toMatchObject({ code: 'COMBO_LIMIT_UNREACHABLE', maxReachable: 7 });
    expect((await owner.c.req('GET', url)).status).toBe(200);
    expect((await ops.c.req('GET', url)).status).toBe(403);
    expect((await customer.c.req('GET', url)).status).toBe(403);
    expect((await new Client().req('GET', url)).status).toBe(401);

    expect((await manager.c.req('PUT', url, { maxTotalCents: 12_000_000 })).status).toBe(403);   // el gerente no cambia límites
    const ok = await owner.c.req('PUT', url, { maxTotalCents: 12_000_000 });
    expect(ok.status).toBe(200);
    expect(ok.body.issues).toEqual([]);
    expect((await new Client().req('GET', `/venues/${s.slug}/menu`)).body.limits.maxTotalCents).toBe(12_000_000);   // la pantalla lo muestra
    expect((await one("SELECT actor_user_id FROM audit_log WHERE tenant_id=$1 AND action='limits.updated'", [s.id])).actor_user_id).toBe(owner.id);
  });

  it('valida la entrada: campos desconocidos 400, valores fuera de rango 422', async () => {
    const s = await seedTenant(); const owner = await user({ tenant: s.id, role: 'owner' });
    const url = `/venues/${s.slug}/staff/limits`;
    expect((await owner.c.req('PUT', url, { maxTotal: 5 })).status).toBe(400);
    expect((await owner.c.req('PUT', url, { maxCombos: 0 })).body.code).toBe('INVALID_LIMITS');
    expect((await owner.c.req('PUT', url, { maxCombos: 'ocho' })).status).toBe(400);
  });

  it('el propietario de otro local no puede ver ni cambiar estos límites', async () => {
    const a = await seedTenant(); const b = await seedTenant();
    const ownerB = await user({ tenant: b.id, role: 'owner' });
    expect((await ownerB.c.req('GET', `/venues/${a.slug}/staff/limits`)).status).toBe(403);
    expect((await ownerB.c.req('PUT', `/venues/${a.slug}/staff/limits`, { maxTotalCents: 1_000_000 })).status).toBe(403);
  });

  it('confirmar la revisión funciona solo para el propietario', async () => {
    const s = await seedTenant();
    const owner = await user({ tenant: s.id, role: 'owner' }); const manager = await user({ tenant: s.id, role: 'manager' });
    await pg.query("UPDATE tenant_settings SET limits_reviewed_at = now() - interval '90 days' WHERE tenant_id=$1", [s.id]);
    expect((await manager.c.req('GET', `/venues/${s.slug}/staff/limits`)).body.reviewDue).toBe(true);
    expect((await manager.c.req('POST', `/venues/${s.slug}/staff/limits/confirm`, {})).status).toBe(403);
    expect((await owner.c.req('POST', `/venues/${s.slug}/staff/limits/confirm`, {})).body.reviewDue).toBe(false);
  });
});
