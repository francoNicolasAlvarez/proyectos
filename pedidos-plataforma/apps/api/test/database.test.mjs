import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(fileURLToPath(new URL('../db/migrations/0001_init.sql', import.meta.url)), 'utf8');

let db;
const ids = {};

/** Ejecuta fn como el rol de la aplicación, con el contexto de tenant/usuario fijado (como hará la API). */
async function asApp({ tenant = '', user = '', admin = false } = {}, fn) {
  return db.transaction(async (tx) => {
    await tx.query('SET LOCAL ROLE app_runtime');
    await tx.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.is_admin', $3, true)",
      [tenant, user, admin ? 'on' : '']);
    return fn(tx);
  });
}
const one = async (sql, params) => (await db.query(sql, params)).rows[0];

before(async () => {
  db = new PGlite();
  await db.exec(migration);

  // Datos de prueba cargados como propietario (sin RLS), dos locales independientes.
  for (const k of ['A', 'B']) {
    ids['t' + k] = (await one("INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id", ['Local ' + k, 'local-' + k.toLowerCase()])).id;
    ids['u' + k] = (await one("INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id", [k.toLowerCase() + '@x.com', 'Cliente ' + k])).id;
    const t = ids['t' + k];
    ids['pp' + k] = (await one("INSERT INTO pickup_points (tenant_id, name, is_default) VALUES ($1, 'Barra 1', true) RETURNING id", [t])).id;
    ids['menu' + k] = (await one("INSERT INTO menus (tenant_id, name, is_default) VALUES ($1, 'Carta', true) RETURNING id", [t])).id;
    ids['cat' + k] = (await one("INSERT INTO categories (tenant_id, menu_id, name) VALUES ($1, $2, 'Cervezas') RETURNING id", [t, ids['menu' + k]])).id;
    ids['prod' + k] = (await one("INSERT INTO products (tenant_id, category_id, name, base_price_cents) VALUES ($1, $2, 'Rubia', 420000) RETURNING id", [t, ids['cat' + k]])).id;
    ids['loc' + k] = (await one("INSERT INTO locations (tenant_id, name) VALUES ($1, 'Mesa 5') RETURNING id", [t])).id;
    ids['ord' + k] = (await one(`INSERT INTO orders (tenant_id, user_id, order_number, counter_date, payment_method, subtotal_cents, total_cents, idempotency_key)
      VALUES ($1, $2, 1, current_date, 'payment_app', 420000, 420000, 'k1') RETURNING id`, [t, ids['u' + k]])).id;
  }
});

describe('esquema', () => {
  test('la migración crea las tablas del diseño', async () => {
    const { rows } = await db.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'");
    assert.ok(rows[0].n >= 30, `tablas: ${rows[0].n}`);
  });

  test('el rol de la aplicación no es superusuario ni evita RLS', async () => {
    const r = await one("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_runtime'");
    assert.equal(r.rolsuper, false);
    assert.equal(r.rolbypassrls, false);
  });

  test('toda tabla con tenant_id tiene RLS activa y forzada', async () => {
    const { rows } = await db.query(`
      SELECT c.relname FROM pg_class c
      JOIN information_schema.columns col ON col.table_name = c.relname AND col.table_schema = 'public' AND col.column_name = 'tenant_id'
      WHERE c.relkind = 'r' AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)`);
    assert.deepEqual(rows.map((r) => r.relname), [], 'tablas con tenant_id sin RLS');
  });
});

describe('aislamiento entre locales (RLS)', () => {
  test('cada local ve solo sus datos', async () => {
    const a = await asApp({ tenant: ids.tA }, (tx) => tx.query('SELECT name, tenant_id FROM products'));
    assert.equal(a.rows.length, 1);
    assert.equal(a.rows[0].tenant_id, ids.tA);
    const b = await asApp({ tenant: ids.tB }, (tx) => tx.query('SELECT tenant_id FROM categories'));
    assert.deepEqual(b.rows.map((r) => r.tenant_id), [ids.tB]);
  });

  test('sin contexto no se ve ninguna fila (seguro por defecto)', async () => {
    for (const t of ['products', 'orders', 'pickup_points', 'payments', 'audit_log', 'tenant_memberships']) {
      const r = await asApp({}, (tx) => tx.query(`SELECT 1 FROM ${t}`));
      assert.equal(r.rows.length, 0, t);
    }
  });

  test('no se puede insertar en otro local', async () => {
    await assert.rejects(
      asApp({ tenant: ids.tA }, (tx) => tx.query("INSERT INTO pickup_points (tenant_id, name) VALUES ($1, 'Intruso')", [ids.tB])),
      /row-level security/i);
  });

  test('no se puede modificar ni borrar datos de otro local', async () => {
    const upd = await asApp({ tenant: ids.tA }, (tx) => tx.query("UPDATE products SET base_price_cents = 1 WHERE id = $1", [ids.prodB]));
    assert.equal(upd.affectedRows, 0);
    const del = await asApp({ tenant: ids.tA }, (tx) => tx.query('DELETE FROM products WHERE id = $1', [ids.prodB]));
    assert.equal(del.affectedRows, 0);
    assert.equal((await one('SELECT base_price_cents::int AS p FROM products WHERE id = $1', [ids.prodB])).p, 420000);
  });

  test('un local no puede mover una fila propia al tenant de otro', async () => {
    await assert.rejects(
      asApp({ tenant: ids.tA }, (tx) => tx.query('UPDATE pickup_points SET tenant_id = $1 WHERE id = $2', [ids.tB, ids.ppA])),
      /row-level security/i);
  });

  test('el administrador de plataforma ve todos los locales', async () => {
    const r = await asApp({ admin: true }, (tx) => tx.query('SELECT DISTINCT tenant_id FROM products'));
    assert.equal(r.rows.length, 2);
  });

  test('un cliente ve solo sus pedidos, de cualquier local, sin tener contexto de tenant', async () => {
    const mine = await asApp({ user: ids.uA }, (tx) => tx.query('SELECT id FROM orders'));
    assert.deepEqual(mine.rows.map((r) => r.id), [ids.ordA]);
  });

  test('un cliente no puede ver las partes de pedidos ajenos', async () => {
    const t = ids.tA;
    await db.query("INSERT INTO order_parts (tenant_id, order_id, pickup_point_id, status) VALUES ($1, $2, $3, 'preparing')", [t, ids.ordA, ids.ppA]);
    await db.query("INSERT INTO order_parts (tenant_id, order_id, pickup_point_id, status) VALUES ($1, $2, $3, 'preparing')", [ids.tB, ids.ordB, ids.ppB]);
    const mine = await asApp({ user: ids.uA }, (tx) => tx.query('SELECT order_id FROM order_parts'));
    assert.deepEqual(mine.rows.map((r) => r.order_id), [ids.ordA]);
    const other = await asApp({ user: ids.uB }, (tx) => tx.query('SELECT order_id FROM order_parts'));
    assert.deepEqual(other.rows.map((r) => r.order_id), [ids.ordB]);
  });

  test('un cliente no puede modificar pedidos de otro', async () => {
    const r = await asApp({ user: ids.uA }, (tx) => tx.query("UPDATE orders SET notes = 'x' WHERE id = $1", [ids.ordB]));
    assert.equal(r.affectedRows, 0);
  });
});

describe('integridad entre locales (claves compuestas)', () => {
  test('un producto no puede apuntar a la categoría de otro local', async () => {
    await assert.rejects(
      db.query("INSERT INTO products (tenant_id, category_id, name, base_price_cents) VALUES ($1, $2, 'x', 1)", [ids.tA, ids.catB]),
      /foreign key/i);
  });

  test('un pedido no puede usar la ubicación de otro local como origen', async () => {
    await assert.rejects(
      db.query(`INSERT INTO orders (tenant_id, user_id, order_number, counter_date, origin_location_id, payment_method, subtotal_cents, total_cents, idempotency_key)
        VALUES ($1, $2, 99, current_date, $3, 'payment_app', 1, 1, 'kx')`, [ids.tA, ids.uA, ids.locB]),
      /foreign key/i);
  });

  test('un ítem no puede colgar de un pedido de otro local', async () => {
    const part = await one("INSERT INTO order_parts (tenant_id, order_id) VALUES ($1, $2) RETURNING id", [ids.tA, ids.ordA]);
    await assert.rejects(
      db.query(`INSERT INTO order_items (tenant_id, order_id, order_part_id, name_snapshot, unit_price_cents, quantity, line_total_cents)
        VALUES ($1, $2, $3, 'x', 1, 1, 1)`, [ids.tB, ids.ordA, part.id]),
      /foreign key/i);
  });

  test('solo un punto de retiro por defecto activo por local', async () => {
    await assert.rejects(
      db.query("INSERT INTO pickup_points (tenant_id, name, is_default) VALUES ($1, 'Otro', true)", [ids.tA]),
      /unique|duplicate/i);
  });
});

describe('pedidos y pagos', () => {
  test('el número de pedido es consecutivo por local y día, y no se mezcla entre locales', async () => {
    const day = '2030-01-01';
    const n1 = (await one('SELECT next_order_number($1, $2::date) AS n', [ids.tA, day])).n;
    const n2 = (await one('SELECT next_order_number($1, $2::date) AS n', [ids.tA, day])).n;
    const nb = (await one('SELECT next_order_number($1, $2::date) AS n', [ids.tB, day])).n;
    const next = (await one('SELECT next_order_number($1, $2::date) AS n', [ids.tA, '2030-01-02'])).n;
    assert.deepEqual([n1, n2, nb, next], [1, 2, 1, 1]);
  });

  test('la misma clave de idempotencia no crea dos pedidos del mismo cliente', async () => {
    await assert.rejects(
      db.query(`INSERT INTO orders (tenant_id, user_id, order_number, counter_date, payment_method, subtotal_cents, total_cents, idempotency_key)
        VALUES ($1, $2, 50, current_date, 'payment_app', 1, 1, 'k1')`, [ids.tA, ids.uA]),
      /unique|duplicate/i);
  });

  test('el estado de pago debe ser coherente con el momento de cobro', async () => {
    await assert.rejects(
      db.query(`INSERT INTO orders (tenant_id, user_id, order_number, counter_date, payment_timing, payment_method, payment_status, subtotal_cents, total_cents, idempotency_key)
        VALUES ($1, $2, 51, current_date, 'prepaid', 'payment_app', 'collected_on_pickup', 1, 1, 'k51')`, [ids.tA, ids.uA]),
      /payment_status_matches_timing/);
    await assert.rejects(
      db.query(`INSERT INTO orders (tenant_id, user_id, order_number, counter_date, payment_timing, payment_method, payment_status, subtotal_cents, total_cents, idempotency_key)
        VALUES ($1, $2, 52, current_date, 'prepaid', 'cash_on_pickup', 'pending', 1, 1, 'k52')`, [ids.tA, ids.uA]),
      /method_matches_timing/);
  });

  test('un pago al retiro con efectivo es válido', async () => {
    await db.query(`INSERT INTO orders (tenant_id, user_id, order_number, counter_date, payment_timing, payment_method, payment_status, subtotal_cents, total_cents, idempotency_key)
      VALUES ($1, $2, 53, current_date, 'on_pickup', 'cash_on_pickup', 'pending_collection', 1, 1, 'k53')`, [ids.tA, ids.uA]);
  });

  test('un mismo pago del proveedor no se puede registrar dos veces', async () => {
    const ins = () => db.query("INSERT INTO payments (tenant_id, order_id, provider, provider_payment_id, amount_cents) VALUES ($1, $2, 'mercadopago', 'MP-1', 100)", [ids.tA, ids.ordA]);
    await ins();
    await assert.rejects(ins(), /unique|duplicate/i);
  });

  test('un webhook repetido se deduplica por el id de evento', async () => {
    const ins = () => db.query("INSERT INTO payment_events (tenant_id, provider, provider_event_id, payload) VALUES ($1, 'mercadopago', 'EV-1', '{}')", [ids.tA]);
    await ins();
    await assert.rejects(ins(), /unique|duplicate/i);
  });

  test('los importes no pueden ser negativos', async () => {
    await assert.rejects(
      db.query("INSERT INTO products (tenant_id, category_id, name, base_price_cents) VALUES ($1, $2, 'x', -1)", [ids.tA, ids.catA]),
      /check/i);
  });

  test('updated_at se actualiza automáticamente', async () => {
    const before = (await one('SELECT updated_at FROM products WHERE id = $1', [ids.prodA])).updated_at;
    await new Promise((r) => setTimeout(r, 15));
    await db.query("UPDATE products SET name = 'Rubia 2' WHERE id = $1", [ids.prodA]);
    const after = (await one('SELECT updated_at FROM products WHERE id = $1', [ids.prodA])).updated_at;
    assert.ok(after > before);
  });
});

describe('retiro con QR', () => {
  let partId;
  before(async () => {
    partId = (await one("INSERT INTO order_parts (tenant_id, order_id, pickup_point_id, status) VALUES ($1, $2, $3, 'ready') RETURNING id", [ids.tA, ids.ordA, ids.ppA])).id;
    await db.query("INSERT INTO pickup_tokens (tenant_id, order_part_id, token_hash, short_code) VALUES ($1, $2, 'hash-1', 'AB12')", [ids.tA, partId]);
  });
  const consume = (hash, tenant = ids.tA) => asApp({ tenant }, (tx) => tx.query(
    "UPDATE pickup_tokens SET used_at = now(), used_by = $2 WHERE token_hash = $1 AND used_at IS NULL RETURNING order_part_id", [hash, ids.uA]));

  test('el token se consume una sola vez', async () => {
    const first = await consume('hash-1');
    assert.equal(first.rows.length, 1);
    const second = await consume('hash-1');
    assert.equal(second.rows.length, 0);
  });

  test('un local no puede consumir el token de otro', async () => {
    await db.query("INSERT INTO pickup_tokens (tenant_id, order_part_id, token_hash, short_code) VALUES ($1, $2, 'hash-2', 'CD34')", [ids.tA, partId]);
    const r = await consume('hash-2', ids.tB);
    assert.equal(r.rows.length, 0);
  });

  test('el código corto no se repite entre tokens vigentes del mismo local, pero se puede reutilizar tras usarse', async () => {
    await db.query("INSERT INTO pickup_tokens (tenant_id, order_part_id, token_hash, short_code) VALUES ($1, $2, 'hash-3', 'ZZ99')", [ids.tA, partId]);
    await assert.rejects(
      db.query("INSERT INTO pickup_tokens (tenant_id, order_part_id, token_hash, short_code) VALUES ($1, $2, 'hash-4', 'ZZ99')", [ids.tA, partId]),
      /unique|duplicate/i);
    // el mismo código en otro local es válido
    const partB = (await one("INSERT INTO order_parts (tenant_id, order_id) VALUES ($1, $2) RETURNING id", [ids.tB, ids.ordB])).id;
    await db.query("INSERT INTO pickup_tokens (tenant_id, order_part_id, token_hash, short_code) VALUES ($1, $2, 'hash-5', 'ZZ99')", [ids.tB, partB]);
    // tras usarse, el código se libera
    await consume('hash-3');
    await db.query("INSERT INTO pickup_tokens (tenant_id, order_part_id, token_hash, short_code) VALUES ($1, $2, 'hash-6', 'ZZ99')", [ids.tA, partId]);
  });

  test('dos escaneos simultáneos del mismo QR: solo uno gana', async () => {
    await db.query("INSERT INTO pickup_tokens (tenant_id, order_part_id, token_hash, short_code) VALUES ($1, $2, 'hash-7', 'RR77')", [ids.tA, partId]);
    const results = await Promise.all([consume('hash-7'), consume('hash-7')]);
    assert.equal(results.filter((r) => r.rows.length === 1).length, 1);
  });
});

describe('auditoría e historial de solo inserción', () => {
  test('la aplicación puede insertar pero no modificar ni borrar la auditoría', async () => {
    await asApp({ tenant: ids.tA }, (tx) => tx.query("INSERT INTO audit_log (tenant_id, action, entity) VALUES ($1, 'product.price_changed', 'product')", [ids.tA]));
    await assert.rejects(asApp({ tenant: ids.tA }, (tx) => tx.query("UPDATE audit_log SET action = 'x'")), /permission denied/i);
    await assert.rejects(asApp({ tenant: ids.tA }, (tx) => tx.query('DELETE FROM audit_log')), /permission denied/i);
  });

  test('el historial de estados es de solo inserción', async () => {
    await asApp({ tenant: ids.tA }, (tx) => tx.query(
      "INSERT INTO order_status_history (tenant_id, order_id, axis, to_status, actor_kind) VALUES ($1, $2, 'operational', 'accepted', 'staff')", [ids.tA, ids.ordA]));
    await assert.rejects(asApp({ tenant: ids.tA }, (tx) => tx.query("UPDATE order_status_history SET to_status = 'x'")), /permission denied/i);
  });

  test('la aplicación no puede alterar el catálogo de motivos de cancelación', async () => {
    await assert.rejects(asApp({ tenant: ids.tA }, (tx) => tx.query("INSERT INTO cancellation_reasons VALUES ('x', 'x')")), /permission denied/i);
  });
});
