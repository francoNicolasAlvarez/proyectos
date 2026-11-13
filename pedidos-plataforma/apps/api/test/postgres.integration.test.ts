/**
 * Pruebas contra un PostgreSQL REAL con varias conexiones (carreras de verdad).
 * Opcionales: se activan con PG_INTEGRATION=1 (levanta un PostgreSQL embebido) o con TEST_DATABASE_URL
 * apuntando a una base vacía (por ejemplo, un servicio de PostgreSQL en CI).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { allSql } from '../db/schema.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withContext, type Database } from '../src/db';
import { createOrder, markPartReady, markPaymentApproved, redeemPickup, transitionOrder } from '../src/order-service';
import { pgDatabase } from '../src/pg-database';

const enabled = !!process.env.PG_INTEGRATION || !!process.env.TEST_DATABASE_URL;
const ROLE = 'app_runtime';

describe.skipIf(!enabled)('PostgreSQL real, varias conexiones', () => {
  let pool: Pool; let db: Database; let stop: (() => Promise<void>) | undefined;
  type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows as Row[];

  beforeAll(async () => {
    let url = process.env.TEST_DATABASE_URL;
    if (!url) {
      const { default: EmbeddedPostgres } = await import('embedded-postgres');
      const dir = mkdtempSync(join(tmpdir(), 'pasamanos-pg-'));
      const port = 54000 + Math.floor(Math.random() * 900);
      const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'pw', port, persistent: false, onLog: () => undefined, onError: () => undefined });
      await server.initialise(); await server.start(); await server.createDatabase('pasamanos');
      stop = async () => { await server.stop(); rmSync(dir, { recursive: true, force: true }); };
      url = `postgres://postgres:pw@localhost:${port}/pasamanos`;
    }
    // Seguridad: este test BORRA el esquema para poder repetirse. Solo se permite sobre bases cuyo nombre termina en _test.
    const dbName = decodeURIComponent(new URL(url).pathname.slice(1));
    if (!/_test$/.test(dbName)) throw new Error(`TEST_DATABASE_URL apunta a "${dbName}": por seguridad el nombre de la base debe terminar en _test`);
    pool = new Pool({ connectionString: url, max: 12 });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pool.query(allSql());
    db = pgDatabase(pool);
  }, 120_000);
  afterAll(async () => { await pool?.end(); await stop?.(); });

  let seq = 0;
  async function seed(settings = '') {
    const n = ++seq;
    const t = (await q("INSERT INTO tenants (name, slug) VALUES ($1,$2) RETURNING id", ['T' + n, 'pg-' + n]))[0]!.id;
    const user = (await q("INSERT INTO users (email, name) VALUES ($1,'U') RETURNING id", [`pg${n}@x.com`]))[0]!.id;
    const staff = (await q("INSERT INTO users (email, name) VALUES ($1,'S') RETURNING id", [`pgs${n}@x.com`]))[0]!.id;
    await q('INSERT INTO tenant_settings (tenant_id) VALUES ($1)', [t]);
    if (settings) await q(`UPDATE tenant_settings SET ${settings} WHERE tenant_id=$1`, [t]);
    await q("INSERT INTO tenant_payment_methods (tenant_id, method, enabled) VALUES ($1,'payment_app',true)", [t]);
    await q("INSERT INTO pickup_points (tenant_id, name, is_default) VALUES ($1,'Barra',true)", [t]);
    const menu = (await q("INSERT INTO menus (tenant_id, name, is_default) VALUES ($1,'Carta',true) RETURNING id", [t]))[0]!.id;
    const cat = (await q("INSERT INTO categories (tenant_id, menu_id, name) VALUES ($1,$2,'C') RETURNING id", [t, menu]))[0]!.id;
    const product = (await q("INSERT INTO products (tenant_id, category_id, name, base_price_cents) VALUES ($1,$2,'P',100000) RETURNING id", [t, cat]))[0]!.id;
    return { t: t as string, user: user as string, staff: staff as string, product: product as string };
  }
  type S = Awaited<ReturnType<typeof seed>>;
  const place = (s: S, key: string) => withContext(db, { tenantId: s.t, userId: s.user, role: ROLE }, (tx) =>
    createOrder(tx, { tenantId: s.t, userId: s.user, idempotencyKey: key, paymentMethod: 'payment_app', items: [{ productId: s.product, quantity: 1, selections: {} }] }));
  const pay = (s: S, o: { orderId: string; totalCents: number }, pid: string) => withContext(db, { tenantId: s.t, role: ROLE }, (tx) =>
    markPaymentApproved(tx, { tenantId: s.t, orderId: o.orderId, provider: 'mp', providerPaymentId: pid, amountCents: o.totalCents }));
  const staffCtx = (s: S) => ({ tenantId: s.t, userId: s.staff, role: ROLE });
  const toPreparing = async (s: S, o: { orderId: string }) => {
    await withContext(db, staffCtx(s), (tx) => transitionOrder(tx, { tenantId: s.t, orderId: o.orderId, to: 'accepted', actor: 'staff', actorUserId: s.staff }));
    await withContext(db, staffCtx(s), (tx) => transitionOrder(tx, { tenantId: s.t, orderId: o.orderId, to: 'preparing', actor: 'staff', actorUserId: s.staff }));
    return (await q('SELECT id FROM order_parts WHERE order_id=$1', [o.orderId]))[0]!.id as string;
  };

  it('el flujo completo funciona con el adaptador de node-postgres', async () => {
    const s = await seed();
    const o = await place(s, 'flow');
    expect(await pay(s, o, 'PG-FLOW')).toBe('approved');
    const partId = await toPreparing(s, o);
    const r = await withContext(db, staffCtx(s), (tx) => markPartReady(tx, { tenantId: s.t, partId, staffUserId: s.staff, secret: 'k' }));
    const done = await withContext(db, staffCtx(s), (tx) => redeemPickup(tx, { tenantId: s.t, staffUserId: s.staff, token: r.token }));
    expect(done.orderDelivered).toBe(true);
    expect((await q('SELECT operational_status FROM orders WHERE id=$1', [o.orderId]))[0]!.operational_status).toBe('delivered');
  });

  it('RLS también aplica con conexiones reales: sin contexto no se ve nada', async () => {
    const s = await seed(); await place(s, 'rls');
    const rows = await withContext(db, { role: ROLE }, (tx) => tx.query('SELECT 1 FROM orders'));
    expect(rows.rows).toHaveLength(0);
  });

  it('10 escaneos simultáneos del mismo QR: exactamente uno entrega', async () => {
    const s = await seed();
    const o = await place(s, 'race-qr'); await pay(s, o, 'PG-QR');
    const partId = await toPreparing(s, o);
    const { token } = await withContext(db, staffCtx(s), (tx) => markPartReady(tx, { tenantId: s.t, partId, staffUserId: s.staff, secret: 'k' }));

    const results = await Promise.allSettled(Array.from({ length: 10 }, () => withContext(db, staffCtx(s), (tx) => redeemPickup(tx, { tenantId: s.t, staffUserId: s.staff, token }))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const codes = results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.code);
    expect(new Set(codes)).toEqual(new Set(['ALREADY_USED']));
    expect((await q("SELECT count(*)::int n FROM order_status_history WHERE order_id=$1 AND axis='part' AND to_status='delivered'", [o.orderId]))[0]!.n).toBe(1);
  });

  it('8 solicitudes simultáneas con la misma clave de idempotencia crean un solo pedido', async () => {
    const s = await seed();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => place(s, 'same-key')));
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof place>>> => r.status === 'fulfilled');
    expect(results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    expect(new Set(ok.map((r) => r.value.orderId)).size).toBe(1);
    expect(ok.filter((r) => !r.value.replayed)).toHaveLength(1);
    expect((await q('SELECT count(*)::int n FROM orders WHERE tenant_id=$1', [s.t]))[0]!.n).toBe(1);
  });

  it('20 pedidos simultáneos reciben números únicos y consecutivos', async () => {
    const s = await seed();
    const res = await Promise.all(Array.from({ length: 20 }, (_, i) => place(s, 'n' + i)));
    expect(res.map((r) => r.orderNumber).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('un webhook repetido en paralelo aprueba el pago una sola vez', async () => {
    const s = await seed();
    const o = await place(s, 'dup-pay');
    const res = await Promise.all(Array.from({ length: 6 }, () => pay(s, o, 'PG-DUP')));
    expect(res.filter((r) => r === 'approved')).toHaveLength(1);
    expect(res.filter((r) => r === 'duplicate')).toHaveLength(5);
    expect((await q('SELECT count(*)::int n FROM payments WHERE order_id=$1', [o.orderId]))[0]!.n).toBe(1);
  });

  it('con el cupo lleno, pedidos simultáneos nuevos se rechazan', async () => {
    const s = await seed('max_concurrent_orders = 2');
    const orders = await Promise.all(Array.from({ length: 2 }, (_, i) => place(s, 'cap' + i)));
    await Promise.all(orders.map((o, i) => pay(s, o, 'PG-CAP' + i)));      // 2 activos: cupo lleno
    const extra = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => place(s, 'over' + i)));
    expect(extra.every((r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'CONCURRENT_LIMIT')).toBe(true);
  });
});
