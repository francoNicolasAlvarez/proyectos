import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allSql } from '../db/schema.mjs';
import { withContext, type Database } from '../src/db';
import { buildApp } from '../src/http/app';
import { dispatchOutbox, type Realtime } from '../src/notifications';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ORIGIN = 'https://app.test';
let pg: PGlite; let db: Database; let app: FastifyInstance;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(allSql());
  db = pg as unknown as Database;
  app = await buildApp({
    db, pickupSecret: 'p', webhookSecret: 'w', encryptionKey: randomBytes(32), provider: { name: 'mercadopago' } as never,
    allowedOrigins: [ORIGIN], publicApiUrl: 'http://localhost:3000', appBaseUrl: 'http://localhost:5173', secureCookies: false, dbRole: 'app_runtime', scryptCost: 2 ** 10,
  });
});
afterAll(async () => { await app.close(); });

const one = async (sql: string, p: unknown[] = []) => (await pg.query<Row>(sql, p)).rows[0] as Row;
let seq = 0;

/** Un local con un pedido rechazado cuyo reembolso quedó en el estado indicado. */
async function seedRefund(status: 'pending' | 'failed' | 'succeeded') {
  const n = ++seq;
  const t = (await one("INSERT INTO tenants (name, slug) VALUES ($1,$2) RETURNING id", ['R' + n, 'ref-' + n])).id as string;
  await pg.query('INSERT INTO tenant_settings (tenant_id) VALUES ($1)', [t]);
  const customer = (await one("INSERT INTO users (email, name) VALUES ($1,'C') RETURNING id", [`rc${n}@x.com`])).id;
  const order = (await one(`INSERT INTO orders (tenant_id, user_id, order_number, counter_date, operational_status, payment_timing, payment_method, payment_status, subtotal_cents, total_cents, idempotency_key)
    VALUES ($1,$2,$3,current_date,'rejected','prepaid','payment_app','refund_pending',940000,940000,$4) RETURNING id`, [t, customer, n, 'rk' + n])).id;
  const pay = (await one("INSERT INTO payments (tenant_id, order_id, provider, provider_payment_id, status, amount_cents) VALUES ($1,$2,'mercadopago',$3,'refund_pending',940000) RETURNING id", [t, order, 'P' + n])).id;
  const refund = (await one("INSERT INTO refunds (tenant_id, payment_id, amount_cents, reason, status, attempts, last_error) VALUES ($1,$2,940000,'out_of_stock',$3,$4,$5) RETURNING id",
    [t, pay, status, status === 'failed' ? 5 : 1, status === 'failed' ? 'mercadopago refund 401: Unauthorized use of live credentials' : null])).id;
  return { id: t, slug: 'ref-' + n, refund: refund as string, orderNumber: n };
}

class Client {
  sid: string | undefined;
  async req(method: 'GET' | 'POST', url: string, body?: unknown) {
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
  const c = new Client(); const email = `ra${++seq}@mail.com`;
  const reg = await c.req('POST', '/auth/register', { email, name: 'U', password: 'una-clave-larga', adultDeclared: true });
  await c.req('POST', '/auth/login', { email, password: 'una-clave-larga' });
  if (role) await pg.query('INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)', [role.tenant, reg.body.id, role.role]);
  return { c, id: reg.body.id as string };
}

describe('reembolsos del local', () => {
  it('el gerente ve los reembolsos con su estado y el motivo del fallo, y puede filtrar', async () => {
    const s = await seedRefund('failed');
    const mgr = await user({ tenant: s.id, role: 'manager' });
    const all = await mgr.c.req('GET', `/venues/${s.slug}/staff/refunds`);
    expect(all.status).toBe(200);
    expect(all.body).toHaveLength(1);
    expect(all.body[0]).toMatchObject({ id: s.refund, status: 'failed', amountCents: 940000, attempts: 5, orderNumber: s.orderNumber, reason: 'out_of_stock' });
    expect(all.body[0].lastError).toContain('401');
    expect((await mgr.c.req('GET', `/venues/${s.slug}/staff/refunds?status=pending`)).body).toEqual([]);
    expect((await mgr.c.req('GET', `/venues/${s.slug}/staff/refunds?status=inventado`)).status).toBe(400);
  });

  it('reintentar devuelve el reembolso fallido a pendiente con los intentos en cero y queda auditado', async () => {
    const s = await seedRefund('failed');
    const owner = await user({ tenant: s.id, role: 'owner' });
    expect((await owner.c.req('POST', `/venues/${s.slug}/staff/refunds/${s.refund}/retry`, {})).body).toEqual({ retrying: true });
    expect(await one('SELECT status, attempts FROM refunds WHERE id=$1', [s.refund])).toMatchObject({ status: 'pending', attempts: 0 });
    const log = await one("SELECT actor_user_id, before, after FROM audit_log WHERE tenant_id=$1 AND action='refund.retry_requested'", [s.id]);
    expect(log.actor_user_id).toBe(owner.id);
    expect(log.before).toMatchObject({ status: 'failed', attempts: 5 });
    expect(log.after).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('solo se reintentan los reembolsos fallidos (no los pendientes ni los ya realizados)', async () => {
    for (const st of ['pending', 'succeeded'] as const) {
      const s = await seedRefund(st); const mgr = await user({ tenant: s.id, role: 'manager' });
      expect((await mgr.c.req('POST', `/venues/${s.slug}/staff/refunds/${s.refund}/retry`, {})).body.code).toBe('REFUND_NOT_RETRYABLE');
    }
  });

  it('permisos: el operador de pedidos y el cliente no pueden; sin sesión 401; otro local no ve nada ni reintenta', async () => {
    const a = await seedRefund('failed'); const b = await seedRefund('failed');
    const ops = await user({ tenant: a.id, role: 'order_operator' }); const door = await user({ tenant: a.id, role: 'pickup_operator' });
    const customer = await user(); const ownerB = await user({ tenant: b.id, role: 'owner' });
    const url = `/venues/${a.slug}/staff/refunds`;
    expect((await ops.c.req('GET', url)).status).toBe(403);
    expect((await door.c.req('POST', `${url}/${a.refund}/retry`, {})).status).toBe(403);
    expect((await customer.c.req('GET', url)).status).toBe(403);
    expect((await new Client().req('GET', url)).status).toBe(401);
    expect((await ownerB.c.req('GET', url)).status).toBe(403);                                   // dueño de otro local
    expect((await ownerB.c.req('POST', `/venues/${b.slug}/staff/refunds/${a.refund}/retry`, {})).body.code).toBe('REFUND_NOT_FOUND');   // id de otro local
    expect((await one('SELECT status FROM refunds WHERE id=$1', [a.refund])).status).toBe('failed');
  });

  it('un reembolso fallido genera una alerta en vivo para el panel del local, sin datos del cliente', async () => {
    const s = await seedRefund('failed');
    await pg.query("INSERT INTO outbox_events (tenant_id, type, payload) VALUES ($1,'refund.failed',$2)", [s.id, JSON.stringify({ refundId: s.refund })]);
    const sent: { channel: string; message: Record<string, unknown> }[] = [];
    const rt: Realtime = { publish: (channel, message) => { sent.push({ channel, message }); } };
    await dispatchOutbox(db, rt, { role: 'app_runtime' });
    const alert = sent.find((m) => m.message.type === 'refund_failed');
    expect(alert).toMatchObject({ channel: `tenant:${s.id}`, message: { type: 'refund_failed', refundId: s.refund } });
    expect(JSON.stringify(sent)).not.toContain('@');
    void withContext;
  });
});
