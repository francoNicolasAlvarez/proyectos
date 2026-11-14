/**
 * Prueba de carga contra PostgreSQL REAL (solo sobre una base cuyo nombre termine en _test: reinicia el esquema).
 *   pnpm run perf            → mide con el esquema actual
 * Siembra un local con 100.000 pedidos históricos y mide con concurrencia real: crear pedidos, confirmar pagos,
 * la cola del local, el menú público y el plan de ejecución de las consultas calientes.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { allSql } from '../db/schema.mjs';
import { withContext } from '../src/db';
import { getPublicMenu, getVenueQueue } from '../src/read-models';
import { createOrder, markPaymentApproved } from '../src/order-service';
import { pgDatabase } from '../src/pg-database';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const env: Record<string, string> = {};
for (const l of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l); if (m && !l.startsWith('#')) env[m[1] as string] = m[2] as string; }
const url = env.TEST_DATABASE_URL;
if (!url) throw new Error('Falta TEST_DATABASE_URL en .env');
const dbName = decodeURIComponent(new URL(url).pathname.slice(1));
if (!/_test$/.test(dbName)) throw new Error(`Por seguridad solo corre sobre bases *_test (esta es "${dbName}")`);

const HISTORY = Number(process.env.PERF_HISTORY ?? 100_000);
const NEW_ORDERS = Number(process.env.PERF_ORDERS ?? 400);
const CONCURRENCY = Number(process.env.PERF_CONCURRENCY ?? 20);

const pool = new pg.Pool({ connectionString: url, max: CONCURRENCY + 4 });
const db = pgDatabase(pool);
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
const ms = () => Number(process.hrtime.bigint() / 1_000_000n);

async function measure<T>(label: string, n: number, concurrency: number, fn: (i: number) => Promise<T>) {
  const times: number[] = []; let next = 0; const t0 = ms();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < n) { const i = next++; const s = ms(); await fn(i); times.push(ms() - s); }
  }));
  const wall = Math.max(1, ms() - t0); times.sort((a, b) => a - b);
  const pct = (p: number) => times[Math.min(times.length - 1, Math.floor(times.length * p))] as number;
  console.log(`${label.padEnd(46)} n=${String(n).padStart(4)}  p50=${String(pct(0.5)).padStart(4)} ms  p95=${String(pct(0.95)).padStart(4)} ms  max=${String(times[times.length - 1]).padStart(4)} ms  ${Math.round((n / wall) * 1000)} op/s`);
}

async function plan(label: string, sql: string, params: unknown[]) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_runtime');
    await c.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [params[0], params[1] ?? '']);
    const r = await c.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`, params);
    const lines = r.rows.map((x) => x['QUERY PLAN'] as string);
    const exec = lines.find((l) => l.startsWith('Execution Time')) ?? '';
    const scans = [...new Set(lines.flatMap((l) => [...l.matchAll(/(Seq Scan|Index Scan|Index Only Scan|Bitmap Heap Scan) (?:using (\S+) )?on (\S+)/g)].map((m) => `${m[1]}${m[2] ? ' [' + m[2] + ']' : ''} ${m[3]}`)))];
    console.log(`  ${label}\n    ${exec}\n    ${scans.join('\n    ')}`);
    await c.query('ROLLBACK');
  } finally { c.release(); }
}

console.log(`Base: ${dbName} · historial: ${HISTORY} pedidos · pedidos nuevos: ${NEW_ORDERS} · concurrencia: ${CONCURRENCY}\n`);
await q('DROP SCHEMA public CASCADE'); await q('CREATE SCHEMA public');
await pool.query(allSql());

// ---------- siembra ----------
const tenant = (await q("INSERT INTO tenants (name, slug) VALUES ('Perf','perf') RETURNING id"))[0]!.id as string;
await q('INSERT INTO tenant_settings (tenant_id, pickup_mode) VALUES ($1,$2)', [tenant, 'per_item']);
await q("INSERT INTO tenant_payment_methods (tenant_id, method, enabled) VALUES ($1,'payment_app',true)", [tenant]);
const barra = (await q("INSERT INTO pickup_points (tenant_id, name, is_default) VALUES ($1,'Barra',true) RETURNING id", [tenant]))[0]!.id;
const comida = (await q("INSERT INTO pickup_points (tenant_id, name) VALUES ($1,'Comida') RETURNING id", [tenant]))[0]!.id;
const menu = (await q("INSERT INTO menus (tenant_id, name, is_default) VALUES ($1,'Carta',true) RETURNING id", [tenant]))[0]!.id;
const cats: string[] = [];
for (let i = 0; i < 8; i++) cats.push((await q('INSERT INTO categories (tenant_id, menu_id, name, sort_order, pickup_point_id) VALUES ($1,$2,$3,$4,$5) RETURNING id', [tenant, menu, 'Cat ' + i, i, i % 2 ? comida : barra]))[0]!.id as string);
await q(`INSERT INTO products (tenant_id, category_id, name, base_price_cents, prep_minutes)
         SELECT $1, ($2::uuid[])[1 + (g % 8)], 'Producto ' || g, 200000 + (g * 1000), 3 FROM generate_series(1, 200) g`, [tenant, cats]);
const prods = (await q('SELECT id FROM products WHERE tenant_id = $1 ORDER BY name', [tenant])).map((r) => r.id as string);
for (const p of prods.slice(0, 40)) {
  const g = (await q("INSERT INTO option_groups (tenant_id, product_id, name, min_select, max_select) VALUES ($1,$2,'Tamaño',1,1) RETURNING id", [tenant, p]))[0]!.id;
  await q("INSERT INTO options (tenant_id, group_id, name, price_delta_cents) VALUES ($1,$2,'Chica',0),($1,$2,'Grande',100000)", [tenant, g]);
}
await q("INSERT INTO users (email, name) SELECT 'perf' || g || '@x.com', 'P' || g FROM generate_series(1, 2000) g");
const users = (await q("SELECT id FROM users WHERE email LIKE 'perf%' ORDER BY email")).map((r) => r.id as string);
const staffUser = users[0] as string;

let t = ms();
await q(`INSERT INTO orders (tenant_id, user_id, order_number, counter_date, operational_status, payment_timing, payment_method, payment_status, subtotal_cents, total_cents, idempotency_key, placed_at, delivered_at)
         SELECT $1, (SELECT id FROM users WHERE email = 'perf' || (1 + g % 2000) || '@x.com'), (g % 400) + 1, DATE '2025-01-01' + (g / 400), 'delivered','prepaid','payment_app','approved', 500000, 500000, 'h' || g,
                (DATE '2025-01-01' + (g / 400))::timestamptz + interval '20 hours', (DATE '2025-01-01' + (g / 400))::timestamptz + interval '20 hours 15 minutes'
         FROM generate_series(1, $2::int) g`, [tenant, HISTORY]);
await q("INSERT INTO order_parts (tenant_id, order_id, status) SELECT tenant_id, id, 'delivered' FROM orders WHERE tenant_id = $1", [tenant]);
await q(`INSERT INTO order_items (tenant_id, order_id, order_part_id, name_snapshot, unit_price_cents, quantity, line_total_cents)
         SELECT o.tenant_id, o.id, p.id, 'X', 500000, 1, 500000 FROM orders o JOIN order_parts p ON p.order_id = o.id WHERE o.tenant_id = $1`, [tenant]);
await q('ANALYZE');
console.log(`Siembra del historial: ${Math.round((ms() - t) / 1000)} s\n`);

// ---------- mediciones ----------
// Calentamiento: abrir todas las conexiones del pool ANTES de medir (cada conexión nueva paga la autenticación scram, ~100 ms+).
await Promise.all(Array.from({ length: CONCURRENCY + 2 }, () => pool.query('SELECT pg_sleep(0.05)')));
const app = { tenantId: tenant, role: 'app_runtime' };
const items = (i: number) => {
  const a = prods[(i * 7) % prods.length] as string; const b = prods[(i * 13 + 1) % prods.length] as string;
  return [{ productId: a, quantity: 1 + (i % 3), selections: {} as Record<string, string[]> }, { productId: b, quantity: 1, selections: {} }];
};
// los 40 primeros tienen variante obligatoria: se eligen productos sin variante
const plain = prods.slice(40);
const plainItems = (i: number) => [{ productId: plain[(i * 7) % plain.length] as string, quantity: 1 + (i % 3), selections: {} }, { productId: plain[(i * 13 + 1) % plain.length] as string, quantity: 1, selections: {} }];
void items;

const created: { orderId: string; totalCents: number; user: string }[] = [];
await measure('crear pedido (con RLS, 2 líneas, 2 puntos)', NEW_ORDERS, CONCURRENCY, async (i) => {
  const u = users[100 + (i % 1500)] as string;     // usuarios distintos: el límite por persona cuenta sus pedidos abiertos
  const r = await withContext(db, { ...app, userId: u }, (tx) => createOrder(tx, { tenantId: tenant, userId: u, idempotencyKey: 'perf-' + i, paymentMethod: 'payment_app', items: plainItems(i) }));
  created.push({ ...r, user: u });
});
await measure('confirmar pago (webhook ya verificado)', created.length, CONCURRENCY, async (i) => {
  const o = created[i] as (typeof created)[number];
  await withContext(db, app, (tx) => markPaymentApproved(tx, { tenantId: tenant, orderId: o.orderId, provider: 'mercadopago', providerPaymentId: 'PF' + i, amountCents: o.totalCents }));
});
await measure('cola del local (' + created.length + ' pedidos abiertos)', 30, 5, () => withContext(db, { ...app, userId: staffUser }, (tx) => getVenueQueue(tx, tenant)));
await measure('menú público (200 productos)', 100, 10, () => withContext(db, app, (tx) => getPublicMenu(tx, tenant)));

console.log('\nPlanes de ejecución (con RLS activa, como en producción):');
const sampleUser = created[0]!.user;
await plan('pedidos abiertos de una persona (límite por persona)',
  `SELECT coalesce(sum(i.line_total_cents),0) FROM orders o JOIN order_items i ON i.tenant_id=o.tenant_id AND i.order_id=o.id
   WHERE o.tenant_id=$1 AND o.user_id=$2 AND (o.operational_status IN ('pending_acceptance','accepted','preparing','ready') OR (o.operational_status='awaiting_payment' AND o.placed_at > now() - interval '10 minutes'))`, [tenant, sampleUser]);
await plan('cupo: pedidos activos del local',
  `SELECT count(*) FROM orders WHERE tenant_id=$1 AND (operational_status IN ('pending_acceptance','accepted','preparing','ready') OR (operational_status='awaiting_payment' AND placed_at > now() - interval '10 minutes'))`, [tenant]);
await plan('historial de un cliente (GET /orders)', `SELECT id FROM orders WHERE user_id=$2 AND tenant_id=$1 ORDER BY placed_at DESC LIMIT 20`, [tenant, sampleUser]);
await plan('ítems de los pedidos abiertos (cola del local)',
  `SELECT i.id FROM order_items i WHERE i.tenant_id=$1 AND i.order_id IN (SELECT id FROM orders WHERE tenant_id=$1 AND operational_status IN ('pending_acceptance','accepted','preparing','ready'))`, [tenant]);
await pool.end();
