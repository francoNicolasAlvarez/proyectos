import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { InvalidTransitionError, PricingError } from '@pasamanos/shared';
import { DomainError, withContext, type Database, type RequestContext } from '../src/db';
import {
  createOrder, getPickupCredentials, markPartReady, markPaymentApproved, redeemPickup, transitionOrder,
} from '../src/order-service';

const SECRET = 'test-secret';
let pg: PGlite;
let db: Database;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync(fileURLToPath(new URL('../db/migrations/0001_init.sql', import.meta.url)), 'utf8'));
  db = pg as unknown as Database;
});

const one = async (sql: string, params: unknown[] = []) => (await pg.query<Record<string, any>>(sql, params)).rows[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let seq = 0;

interface Seed {
  id: string; customer: string; staff: string; barra: string; comida: string; location: string;
  beer: string; fries: string; sold: string; lemonade: string; catBeer: string;
  size: { group: string; pint: string; liter: string }; extras: { group: string; ginger: string; mint: string; honey: string };
}

/** Un local completo con su propio catálogo, cargado como propietario (sin RLS). */
async function seedTenant(opts: { mode?: 'single_point' | 'per_item'; settings?: string; points?: number } = {}): Promise<Seed> {
  const n = ++seq;
  const t = (await one("INSERT INTO tenants (name, slug) VALUES ($1,$2) RETURNING id", ['Local ' + n, 'local-' + n])).id;
  const customer = (await one("INSERT INTO users (email, name) VALUES ($1,'Cliente') RETURNING id", [`c${n}@x.com`])).id;
  const staff = (await one("INSERT INTO users (email, name) VALUES ($1,'Empleado') RETURNING id", [`s${n}@x.com`])).id;
  await pg.query("INSERT INTO tenant_settings (tenant_id, pickup_mode) VALUES ($1,$2)", [t, opts.mode ?? 'single_point']);
  if (opts.settings) await pg.query(`UPDATE tenant_settings SET ${opts.settings} WHERE tenant_id=$1`, [t]);
  await pg.query("INSERT INTO tenant_payment_methods (tenant_id, method, enabled) VALUES ($1,'payment_app',true),($1,'card_online',true),($1,'cash_on_pickup',true)", [t]);
  const barra = (await one("INSERT INTO pickup_points (tenant_id, name, is_default) VALUES ($1,'Barra 1',true) RETURNING id", [t])).id;
  const comida = (opts.points ?? 2) > 1 ? (await one("INSERT INTO pickup_points (tenant_id, name) VALUES ($1,'Punto de comida') RETURNING id", [t])).id : barra;
  const menu = (await one("INSERT INTO menus (tenant_id, name, is_default) VALUES ($1,'Carta',true) RETURNING id", [t])).id;
  const catBeer = (await one("INSERT INTO categories (tenant_id, menu_id, name, pickup_point_id) VALUES ($1,$2,'Cervezas',$3) RETURNING id", [t, menu, barra])).id;
  const catFood = (await one("INSERT INTO categories (tenant_id, menu_id, name, pickup_point_id) VALUES ($1,$2,'Comidas',$3) RETURNING id", [t, menu, comida])).id;
  const prod = async (cat: string, name: string, price: number, prep: number, available = true) =>
    (await one("INSERT INTO products (tenant_id, category_id, name, base_price_cents, prep_minutes, available) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id", [t, cat, name, price, prep, available])).id;
  const beer = await prod(catBeer, 'Rubia Lager', 420_000, 2);
  const lemonade = await prod(catBeer, 'Limonada', 320_000, 3);
  const fries = await prod(catFood, 'Papas fritas', 520_000, 12);
  const sold = await prod(catFood, 'Hamburguesa', 980_000, 15, false);
  const sg = (await one("INSERT INTO option_groups (tenant_id, product_id, name, min_select, max_select) VALUES ($1,$2,'Tamaño',1,1) RETURNING id", [t, beer])).id;
  const pint = (await one("INSERT INTO options (tenant_id, group_id, name, price_delta_cents) VALUES ($1,$2,'Pinta',0) RETURNING id", [t, sg])).id;
  const liter = (await one("INSERT INTO options (tenant_id, group_id, name, price_delta_cents) VALUES ($1,$2,'Jarra',380000) RETURNING id", [t, sg])).id;
  const eg = (await one("INSERT INTO option_groups (tenant_id, product_id, name, min_select, max_select) VALUES ($1,$2,'Agregados',0,2) RETURNING id", [t, lemonade])).id;
  const [ginger, mint, honey] = await Promise.all(['Jengibre', 'Menta', 'Miel'].map(async (nm) =>
    (await one("INSERT INTO options (tenant_id, group_id, name, price_delta_cents) VALUES ($1,$2,$3,30000) RETURNING id", [t, eg, nm])).id));
  const location = (await one("INSERT INTO locations (tenant_id, name) VALUES ($1,'Mesa 5') RETURNING id", [t])).id;
  return { id: t, customer, staff, barra, comida, location, beer, fries, sold, lemonade, catBeer,
    size: { group: sg, pint, liter }, extras: { group: eg, ginger, mint, honey } };
}

const asCustomer = (s: Seed): RequestContext => ({ tenantId: s.id, userId: s.customer, role: 'app_runtime' });
const asStaff = (s: Seed): RequestContext => ({ tenantId: s.id, userId: s.staff, role: 'app_runtime' });
const asSystem = (s: Seed): RequestContext => ({ tenantId: s.id, role: 'app_runtime' });

const beerLine = (s: Seed, qty = 1, size: 'pint' | 'liter' = 'pint') => ({ productId: s.beer, quantity: qty, selections: { [s.size.group]: [s.size[size]] } });
const friesLine = (s: Seed, qty = 1) => ({ productId: s.fries, quantity: qty, selections: {} });
let keySeq = 0;
const place = (s: Seed, items: any[], extra: Record<string, unknown> = {}) => // eslint-disable-line @typescript-eslint/no-explicit-any
  withContext(db, asCustomer(s), (tx) => createOrder(tx, { tenantId: s.id, userId: s.customer, idempotencyKey: 'key-' + ++keySeq, paymentMethod: 'payment_app', items, ...extra }));
const pay = (s: Seed, orderId: string, amountCents: number, pid = 'MP-' + ++keySeq) =>
  withContext(db, asSystem(s), (tx) => markPaymentApproved(tx, { tenantId: s.id, orderId, provider: 'mercadopago', providerPaymentId: pid, amountCents }));
const move = (s: Seed, orderId: string, to: any, extra: Record<string, unknown> = {}) => // eslint-disable-line @typescript-eslint/no-explicit-any
  withContext(db, asStaff(s), (tx) => transitionOrder(tx, { tenantId: s.id, orderId, to, actor: 'staff', actorUserId: s.staff, ...extra }));
const parts = async (orderId: string) => (await pg.query<Record<string, any>>('SELECT * FROM order_parts WHERE order_id=$1 ORDER BY created_at', [orderId])).rows; // eslint-disable-line @typescript-eslint/no-explicit-any
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code?: string }).code ?? (e as Error).constructor.name; } return null; };

/** Lleva un pedido hasta "en preparación" (pagado y aceptado). */
async function toPreparing(s: Seed, items: any[]) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const o = await place(s, items);
  await pay(s, o.orderId, o.totalCents);
  await move(s, o.orderId, 'accepted', { etaMinutes: 10 });
  await move(s, o.orderId, 'preparing');
  return o;
}
const ready = (s: Seed, partId: string, pickupPointId?: string) =>
  withContext(db, asStaff(s), (tx) => markPartReady(tx, { tenantId: s.id, partId, staffUserId: s.staff, secret: SECRET, pickupPointId }));
const redeem = (s: Seed, v: { token?: string; shortCode?: string }, ctx: RequestContext = asStaff(s)) =>
  withContext(db, ctx, (tx) => redeemPickup(tx, { tenantId: s.id, staffUserId: s.staff, ...v }));

describe('crear pedido', () => {
  it('guarda snapshots, totales, estado inicial, historial y evento', async () => {
    const s = await seedTenant();
    const o = await place(s, [beerLine(s, 2, 'liter'), friesLine(s)], { originLocationId: s.location });
    expect(o.totalCents).toBe(2 * 800_000 + 520_000);
    expect(o.orderNumber).toBe(1);
    const order = await one('SELECT * FROM orders WHERE id=$1', [o.orderId]);
    expect(order).toMatchObject({ operational_status: 'awaiting_payment', payment_status: 'pending', payment_timing: 'prepaid', origin_location_name_snapshot: 'Mesa 5' });
    const items = (await pg.query<Record<string, any>>('SELECT * FROM order_items WHERE order_id=$1 ORDER BY name_snapshot', [o.orderId])).rows; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(items.map((i) => [i.name_snapshot, Number(i.unit_price_cents), i.quantity])).toEqual([['Papas fritas', 520_000, 1], ['Rubia Lager', 800_000, 2]]);
    const sel = await one("SELECT name_snapshot, group_name_snapshot, price_delta_cents FROM order_item_selections WHERE name_snapshot='Jarra'");
    expect(sel).toMatchObject({ group_name_snapshot: 'Tamaño', name_snapshot: 'Jarra' });
    expect(Number((await one('SELECT count(*)::int n FROM order_status_history WHERE order_id=$1', [o.orderId])).n)).toBe(1);
    expect((await one("SELECT count(*)::int n FROM outbox_events WHERE type='order.created' AND tenant_id=$1", [s.id])).n).toBe(1);
  });

  it('el número de pedido es consecutivo dentro del local', async () => {
    const s = await seedTenant();
    const a = await place(s, [friesLine(s)]);
    const b = await place(s, [friesLine(s)]);
    expect([a.orderNumber, b.orderNumber]).toEqual([1, 2]);
  });

  it('es idempotente: la misma clave devuelve el mismo pedido y no duplica', async () => {
    const s = await seedTenant();
    const run = () => withContext(db, asCustomer(s), (tx) => createOrder(tx, { tenantId: s.id, userId: s.customer, idempotencyKey: 'same', paymentMethod: 'payment_app', items: [friesLine(s)] }));
    const a = await run(); const b = await run();
    expect(b).toMatchObject({ orderId: a.orderId, replayed: true });
    expect((await one('SELECT count(*)::int n FROM orders WHERE tenant_id=$1', [s.id])).n).toBe(1);
  });

  it('no permite reutilizar una clave de idempotencia en otro local', async () => {
    const a = await seedTenant(); const b = await seedTenant();
    await withContext(db, asCustomer(a), (tx) => createOrder(tx, { tenantId: a.id, userId: a.customer, idempotencyKey: 'dup', paymentMethod: 'payment_app', items: [friesLine(a)] }));
    const err = await code(withContext(db, { tenantId: b.id, userId: a.customer, role: 'app_runtime' }, (tx) =>
      createOrder(tx, { tenantId: b.id, userId: a.customer, idempotencyKey: 'dup', paymentMethod: 'payment_app', items: [friesLine(b)] })));
    expect(err).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('el pedido conserva los precios aunque el catálogo cambie después', async () => {
    const s = await seedTenant();
    const o = await place(s, [friesLine(s)]);
    await pg.query('UPDATE products SET base_price_cents = 999999 WHERE id=$1', [s.fries]);
    expect(Number((await one('SELECT unit_price_cents FROM order_items WHERE order_id=$1', [o.orderId])).unit_price_cents)).toBe(520_000);
  });

  it.each([
    ['producto agotado', (s: Seed) => [{ productId: s.sold, quantity: 1, selections: {} }], 'PRODUCT_UNAVAILABLE'],
    ['falta la variante obligatoria', (s: Seed) => [{ productId: s.beer, quantity: 1, selections: {} }], 'SELECTION_BELOW_MIN'],
    ['demasiados agregados', (s: Seed) => [{ productId: s.lemonade, quantity: 1, selections: { [s.extras.group]: [s.extras.ginger, s.extras.mint, s.extras.honey] } }], 'SELECTION_ABOVE_MAX'],
    ['producto de otro local', () => [{ productId: '00000000-0000-0000-0000-000000000000', quantity: 1, selections: {} }], 'UNKNOWN_PRODUCT'],
    ['carrito vacío', () => [], 'EMPTY_CART'],
  ])('rechaza: %s', async (_name, items, expected) => {
    const s = await seedTenant();
    const err = await place(s, items(s)).catch((e) => e);
    expect(err).toBeInstanceOf(PricingError);
    expect(err.code).toBe(expected);
  });

  it('rechaza productos de una categoría pausada', async () => {
    const s = await seedTenant();
    await pg.query('UPDATE categories SET paused = true WHERE id=$1', [s.catBeer]);
    expect(await code(place(s, [beerLine(s)]))).toBe('PRODUCT_UNAVAILABLE');
  });

  it('no usa productos de otro local aunque se conozca su id', async () => {
    const a = await seedTenant(); const b = await seedTenant();
    expect(await code(place(a, [{ productId: b.fries, quantity: 1, selections: {} }]))).toBe('UNKNOWN_PRODUCT');
  });

  it('solo acepta medios de pago electrónicos y habilitados (MVP 1)', async () => {
    const s = await seedTenant();
    const withMethod = (m: any) => withContext(db, asCustomer(s), (tx) => createOrder(tx, { tenantId: s.id, userId: s.customer, idempotencyKey: 'm' + ++keySeq, paymentMethod: m, items: [friesLine(s)] })); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(await code(withMethod('cash_on_pickup'))).toBe('PAYMENT_METHOD_NOT_AVAILABLE');
    await pg.query("UPDATE tenant_payment_methods SET enabled=false WHERE tenant_id=$1 AND method='card_online'", [s.id]);
    expect(await code(withMethod('card_online'))).toBe('PAYMENT_METHOD_NOT_AVAILABLE');
  });

  it('valida el origen: debe existir, estar activo y ser del mismo local', async () => {
    const a = await seedTenant(); const b = await seedTenant();
    expect(await code(place(a, [friesLine(a)], { originLocationId: b.location }))).toBe('INVALID_ORIGIN');
    await pg.query('UPDATE locations SET active=false WHERE id=$1', [a.location]);
    expect(await code(place(a, [friesLine(a)], { originLocationId: a.location }))).toBe('INVALID_ORIGIN');
    const ok = await place(a, [friesLine(a)]);   // sin origen también es válido
    expect((await one('SELECT origin_location_id FROM orders WHERE id=$1', [ok.orderId])).origin_location_id).toBeNull();
  });

  it('un local suspendido no recibe pedidos', async () => {
    const s = await seedTenant();
    await pg.query("UPDATE tenants SET status='suspended' WHERE id=$1", [s.id]);
    expect(await code(place(s, [friesLine(s)]))).toBe('TENANT_NOT_ACTIVE');
  });
});

describe('capacidad y horarios', () => {
  it('pedidos pausados', async () => {
    const s = await seedTenant({ settings: 'ordering_paused = true' });
    expect(await code(place(s, [friesLine(s)]))).toBe('PAUSED');
  });

  it('fuera del horario de atención', async () => {
    const s = await seedTenant();
    await pg.query("INSERT INTO opening_hours (tenant_id, weekday, opens_at, closes_at) VALUES ($1, 1, '10:00', '12:00')", [s.id]);
    const monday11 = new Date('2030-01-07T14:00:00Z');   // lunes 11:00 en Buenos Aires (UTC-3)
    const monday13 = new Date('2030-01-07T16:00:00Z');
    expect((await place(s, [friesLine(s)], { now: monday11 })).orderNumber).toBe(1);
    expect(await code(place(s, [friesLine(s)], { now: monday13 }))).toBe('CLOSED');
  });

  it('límite de pedidos simultáneos: cuenta los pendientes de aceptación y en curso', async () => {
    const s = await seedTenant({ settings: 'max_concurrent_orders = 1' });
    const first = await place(s, [friesLine(s)]);                 // sin pagar: todavía no ocupa capacidad
    const second = await place(s, [friesLine(s)]);
    await pay(s, first.orderId, first.totalCents);                // ahora ocupa el cupo
    expect(await code(place(s, [friesLine(s)]))).toBe('CONCURRENT_LIMIT');
    await move(s, first.orderId, 'rejected', { reasonCode: 'capacity_exceeded' });
    expect(second.orderNumber).toBe(2);
    expect((await place(s, [friesLine(s)])).orderNumber).toBe(3);  // se liberó el cupo
  });

  it('límite por intervalo', async () => {
    const s = await seedTenant({ settings: 'max_orders_per_interval = 2, interval_minutes = 10' });
    await place(s, [friesLine(s)]); await place(s, [friesLine(s)]);
    expect(await code(place(s, [friesLine(s)]))).toBe('INTERVAL_LIMIT');
  });
});

describe('puntos de retiro y partes', () => {
  it('single_point con varios puntos: una parte sin punto hasta que el empleado lo asigna (D1)', async () => {
    const s = await seedTenant();
    const o = await place(s, [beerLine(s), friesLine(s)]);
    const ps = await parts(o.orderId);
    expect(ps).toHaveLength(1);
    expect(ps[0]?.pickup_point_id).toBeNull();
  });

  it('single_point con un único punto: se asigna al crear', async () => {
    const s = await seedTenant({ points: 1 });
    const o = await place(s, [beerLine(s), friesLine(s)]);
    expect((await parts(o.orderId))[0]?.pickup_point_id).toBe(s.barra);
  });

  it('per_item: una parte por punto y los ítems agrupados', async () => {
    const s = await seedTenant({ mode: 'per_item' });
    const o = await place(s, [beerLine(s), friesLine(s), { productId: s.lemonade, quantity: 1, selections: {} }]);
    const ps = await parts(o.orderId);
    expect(ps.map((p) => p.pickup_point_id).sort()).toEqual([s.barra, s.comida].sort());
    const barra = ps.find((p) => p.pickup_point_id === s.barra) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(Number((await one('SELECT count(*)::int n FROM order_items WHERE order_part_id=$1', [barra.id])).n)).toBe(2);
  });
});

describe('pago', () => {
  it('un pago aprobado deja el pedido pendiente de aceptación para el local', async () => {
    const s = await seedTenant();
    const o = await place(s, [friesLine(s)]);
    expect(await pay(s, o.orderId, o.totalCents)).toBe('approved');
    const order = await one('SELECT operational_status, payment_status FROM orders WHERE id=$1', [o.orderId]);
    expect(order).toMatchObject({ operational_status: 'pending_acceptance', payment_status: 'approved' });
    expect((await one('SELECT status FROM payments WHERE order_id=$1', [o.orderId])).status).toBe('approved');
  });

  it('un webhook repetido no procesa dos veces', async () => {
    const s = await seedTenant();
    const o = await place(s, [friesLine(s)]);
    expect(await pay(s, o.orderId, o.totalCents, 'MP-X')).toBe('approved');
    expect(await pay(s, o.orderId, o.totalCents, 'MP-X')).toBe('duplicate');
    expect((await one('SELECT count(*)::int n FROM payments WHERE order_id=$1', [o.orderId])).n).toBe(1);
    expect((await one("SELECT count(*)::int n FROM order_status_history WHERE order_id=$1 AND axis='payment'", [o.orderId])).n).toBe(1);
  });

  it('un importe distinto al del pedido se rechaza y no cambia nada', async () => {
    const s = await seedTenant();
    const o = await place(s, [friesLine(s)]);
    expect(await code(pay(s, o.orderId, o.totalCents - 1))).toBe('AMOUNT_MISMATCH');
    expect((await one('SELECT payment_status, operational_status FROM orders WHERE id=$1', [o.orderId]))).toMatchObject({ payment_status: 'pending', operational_status: 'awaiting_payment' });
    expect((await one('SELECT count(*)::int n FROM payments WHERE order_id=$1', [o.orderId])).n).toBe(0);
  });

  it('con aceptación automática el pedido pasa directo a aceptado', async () => {
    const s = await seedTenant({ settings: "acceptance_mode = 'auto'" });
    const o = await place(s, [friesLine(s)]);
    await pay(s, o.orderId, o.totalCents);
    expect((await one('SELECT operational_status FROM orders WHERE id=$1', [o.orderId])).operational_status).toBe('accepted');
  });

  it('un pago que llega después de cancelar el pedido se reembolsa', async () => {
    const s = await seedTenant();
    const o = await place(s, [friesLine(s)]);
    await withContext(db, asCustomer(s), (tx) => transitionOrder(tx, { tenantId: s.id, orderId: o.orderId, to: 'cancelled', actor: 'customer', actorUserId: s.customer }));
    expect(await pay(s, o.orderId, o.totalCents)).toBe('refunding_late_payment');
    expect((await one('SELECT operational_status, payment_status FROM orders WHERE id=$1', [o.orderId]))).toMatchObject({ operational_status: 'cancelled', payment_status: 'refund_pending' });
    expect(Number((await one('SELECT amount_cents FROM refunds WHERE tenant_id=$1', [s.id])).amount_cents)).toBe(o.totalCents);
  });

  it('un pago que llega con el pedido vencido se registra y se reembolsa', async () => {
    const s = await seedTenant();
    const o = await place(s, [friesLine(s)]);
    await pg.query("UPDATE orders SET payment_status='expired' WHERE id=$1", [o.orderId]);
    expect(await pay(s, o.orderId, o.totalCents)).toBe('refunding_late_payment');
    expect((await one('SELECT status FROM payments WHERE order_id=$1', [o.orderId])).status).toBe('refund_pending');
    expect((await one('SELECT count(*)::int n FROM refunds WHERE tenant_id=$1', [s.id])).n).toBe(1);
  });
});

describe('aceptación, rechazo y cancelación', () => {
  it('aceptar fija la hora y el tiempo estimado indicado por el local', async () => {
    const s = await seedTenant();
    const o = await place(s, [friesLine(s)]);
    await pay(s, o.orderId, o.totalCents);
    await move(s, o.orderId, 'accepted', { etaMinutes: 25 });
    const order = await one("SELECT accepted_at, estimated_ready_at > now() + interval '24 minutes' AS eta_ok FROM orders WHERE id=$1", [o.orderId]);
    expect(order.accepted_at).not.toBeNull();
    expect(order.eta_ok).toBe(true);
  });

  it('rechazar exige un motivo y un pedido pagado inicia el reembolso total', async () => {
    const s = await seedTenant();
    const o = await place(s, [beerLine(s, 2), friesLine(s)]);
    await pay(s, o.orderId, o.totalCents);
    expect(await code(move(s, o.orderId, 'rejected'))).toBe('REASON_REQUIRED');
    const res = await move(s, o.orderId, 'rejected', { reasonCode: 'out_of_stock' });
    expect(res.refundRequested).toBe(true);
    expect((await one('SELECT operational_status, payment_status, cancel_reason_code, cancelled_by FROM orders WHERE id=$1', [o.orderId])))
      .toMatchObject({ operational_status: 'rejected', payment_status: 'refund_pending', cancel_reason_code: 'out_of_stock', cancelled_by: 'staff' });
    expect((await one('SELECT amount_cents, status FROM refunds WHERE tenant_id=$1', [s.id]))).toMatchObject({ status: 'pending' });
    expect((await parts(o.orderId)).every((p) => p.status === 'cancelled')).toBe(true);
    expect((await one("SELECT count(*)::int n FROM outbox_events WHERE type='refund.requested' AND tenant_id=$1", [s.id])).n).toBe(1);
  });

  it('el cliente puede cancelar antes de la aceptación (con reembolso) pero no después', async () => {
    const s = await seedTenant();
    const a = await place(s, [friesLine(s)]);
    await pay(s, a.orderId, a.totalCents);
    const cancel = (id: string) => withContext(db, asCustomer(s), (tx) => transitionOrder(tx, { tenantId: s.id, orderId: id, to: 'cancelled', actor: 'customer', actorUserId: s.customer }));
    expect((await cancel(a.orderId)).refundRequested).toBe(true);

    const b = await place(s, [friesLine(s)]);
    await pay(s, b.orderId, b.totalCents);
    await move(s, b.orderId, 'accepted');
    await expect(cancel(b.orderId)).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it('un cliente no puede operar pedidos de otro cliente', async () => {
    const s = await seedTenant();
    const intruder = (await one("INSERT INTO users (email, name) VALUES ('intruso@x.com','X') RETURNING id")).id;
    const o = await place(s, [friesLine(s)]);
    // Sin contexto de tenant ni propiedad, el pedido ni siquiera es visible.
    const err = await code(withContext(db, { userId: intruder, role: 'app_runtime' }, (tx) =>
      transitionOrder(tx, { tenantId: s.id, orderId: o.orderId, to: 'cancelled', actor: 'customer' })));
    expect(err).toBe('ORDER_NOT_FOUND');
  });

  it('un cliente no puede cancelar el pedido de otro cliente del mismo local, ni aun con el contexto del local', async () => {
    const s = await seedTenant();
    const other = (await one("INSERT INTO users (email, name) VALUES ('vecino@x.com','V') RETURNING id")).id;
    const o = await place(s, [friesLine(s)]);
    const err = await code(withContext(db, { tenantId: s.id, userId: other, role: 'app_runtime' }, (tx) =>
      transitionOrder(tx, { tenantId: s.id, orderId: o.orderId, to: 'cancelled', actor: 'customer', actorUserId: other })));
    expect(err).toBe('ORDER_NOT_FOUND');
    expect((await one('SELECT operational_status FROM orders WHERE id=$1', [o.orderId])).operational_status).toBe('awaiting_payment');
    // sin identificar al cliente tampoco se puede
    expect(await code(withContext(db, asCustomer(s), (tx) =>
      transitionOrder(tx, { tenantId: s.id, orderId: o.orderId, to: 'cancelled', actor: 'customer' })))).toBe('ORDER_NOT_FOUND');
  });

  it('no se puede saltear pasos', async () => {
    const s = await seedTenant();
    const o = await place(s, [friesLine(s)]);
    await pay(s, o.orderId, o.totalCents);
    await expect(move(s, o.orderId, 'ready')).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(move(s, o.orderId, 'delivered')).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it('un local no puede operar pedidos de otro local', async () => {
    const a = await seedTenant(); const b = await seedTenant();
    const o = await place(a, [friesLine(a)]);
    await pay(a, o.orderId, o.totalCents);
    expect(await code(withContext(db, asStaff(b), (tx) => transitionOrder(tx, { tenantId: b.id, orderId: o.orderId, to: 'accepted', actor: 'staff' })))).toBe('ORDER_NOT_FOUND');
  });
});

describe('preparación y retiro con QR', () => {
  it('el empleado debe asignar el punto de retiro al marcar listo (D1) y se emite el QR', async () => {
    const s = await seedTenant();
    const o = await toPreparing(s, [beerLine(s), friesLine(s)]);
    const [part] = await parts(o.orderId);
    expect(await code(ready(s, part?.id))).toBe('PICKUP_POINT_REQUIRED');
    const other = await seedTenant();
    expect(await code(ready(s, part?.id, other.barra))).toBe('INVALID_PICKUP_POINT');   // punto de otro local
    const r = await ready(s, part?.id, s.comida);
    expect(r.orderReady).toBe(true);
    expect(r.shortCode).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
    expect((await one('SELECT pickup_point_id, status FROM order_parts WHERE id=$1', [part?.id]))).toMatchObject({ pickup_point_id: s.comida, status: 'ready' });
    expect((await one('SELECT operational_status FROM orders WHERE id=$1', [o.orderId])).operational_status).toBe('ready');
  });

  it('el token no se guarda en claro: solo su hash', async () => {
    const s = await seedTenant({ points: 1 });
    const o = await toPreparing(s, [friesLine(s)]);
    const [part] = await parts(o.orderId);
    const r = await ready(s, part?.id);
    const row = await one('SELECT token_hash FROM pickup_tokens WHERE order_part_id=$1', [part?.id]);
    expect(row.token_hash).not.toContain(r.token);
    expect(row.token_hash).toHaveLength(64);
  });

  it('retira con el QR: entrega una sola vez y registra quién y cuándo', async () => {
    const s = await seedTenant({ points: 1 });
    const o = await toPreparing(s, [friesLine(s)]);
    const [part] = await parts(o.orderId);
    const { token } = await ready(s, part?.id);
    const res = await redeem(s, { token });
    expect(res).toMatchObject({ orderNumber: 1, orderDelivered: true });
    expect((await one('SELECT status, delivered_by, delivered_at FROM order_parts WHERE id=$1', [part?.id]))).toMatchObject({ status: 'delivered', delivered_by: s.staff });
    expect((await one('SELECT operational_status, delivered_at FROM orders WHERE id=$1', [o.orderId])).operational_status).toBe('delivered');
    expect(await code(redeem(s, { token }))).toBe('ALREADY_USED');
  });

  it('también se puede retirar con el código corto (sin distinguir mayúsculas)', async () => {
    const s = await seedTenant({ points: 1 });
    const o = await toPreparing(s, [friesLine(s)]);
    const { shortCode } = await ready(s, (await parts(o.orderId))[0]?.id);
    await redeem(s, { shortCode: shortCode.toLowerCase() });
    expect(await code(redeem(s, { shortCode }))).toBe('ALREADY_USED');   // el empleado ve "ya utilizado", no "inválido"
  });

  it('rechaza códigos y QR inválidos', async () => {
    const s = await seedTenant();
    expect(await code(redeem(s, { shortCode: 'ZZZZ' }))).toBe('INVALID_CODE');
    expect(await code(redeem(s, { token: 'falso' }))).toBe('INVALID_CODE');
    expect(await code(redeem(s, {}))).toBe('INVALID_CODE');
  });

  it('un local no puede entregar pedidos de otro local', async () => {
    const a = await seedTenant({ points: 1 }); const b = await seedTenant({ points: 1 });
    const o = await toPreparing(a, [friesLine(a)]);
    const { token, shortCode } = await ready(a, (await parts(o.orderId))[0]?.id);
    expect(await code(redeem(b, { token }, asStaff(b)))).toBe('INVALID_CODE');
    expect(await code(redeem(b, { shortCode }, asStaff(b)))).toBe('INVALID_CODE');
    expect((await one('SELECT used_at FROM pickup_tokens WHERE tenant_id=$1', [a.id])).used_at).toBeNull();
  });

  it('per_item: el pedido pasa a listo y a entregado solo cuando todas las partes lo están', async () => {
    const s = await seedTenant({ mode: 'per_item' });
    const o = await toPreparing(s, [beerLine(s), friesLine(s)]);
    const [p1, p2] = await parts(o.orderId);
    const r1 = await ready(s, p1?.id);
    expect(r1.orderReady).toBe(false);
    expect((await one('SELECT operational_status FROM orders WHERE id=$1', [o.orderId])).operational_status).toBe('preparing');
    const r2 = await ready(s, p2?.id);
    expect(r2.orderReady).toBe(true);

    expect((await redeem(s, { token: r1.token })).orderDelivered).toBe(false);
    expect((await one('SELECT operational_status FROM orders WHERE id=$1', [o.orderId])).operational_status).toBe('ready');
    expect((await redeem(s, { token: r2.token })).orderDelivered).toBe(true);
    expect((await one('SELECT operational_status FROM orders WHERE id=$1', [o.orderId])).operational_status).toBe('delivered');
  });

  it('el cliente puede volver a ver su QR, pero no puede consumirlo', async () => {
    const s = await seedTenant({ points: 1 });
    const o = await toPreparing(s, [friesLine(s)]);
    const partId = (await parts(o.orderId))[0]?.id;
    const issued = await ready(s, partId);
    const customerView = await withContext(db, { userId: s.customer, role: 'app_runtime' }, (tx) => getPickupCredentials(tx, { tenantId: s.id, partId, secret: SECRET }));
    expect(customerView).toMatchObject({ token: issued.token, shortCode: issued.shortCode, used: false });
    // RLS: puede leer, no modificar
    const upd = await withContext(db, { userId: s.customer, role: 'app_runtime' }, (tx) => tx.query("UPDATE pickup_tokens SET used_at = now() WHERE order_part_id = $1", [partId]));
    expect(upd.affectedRows).toBe(0);
    // otro cliente no ve nada
    const stranger = (await one("INSERT INTO users (email, name) VALUES ('otro@x.com','Otro') RETURNING id")).id;
    expect(await withContext(db, { userId: stranger, role: 'app_runtime' }, (tx) => getPickupCredentials(tx, { tenantId: s.id, partId, secret: SECRET }))).toBeNull();
  });

  it('el historial refleja el ciclo completo en orden', async () => {
    const s = await seedTenant({ points: 1 });
    const o = await toPreparing(s, [friesLine(s)]);
    const { token } = await ready(s, (await parts(o.orderId))[0]?.id);
    await redeem(s, { token });
    const h = (await pg.query<Record<string, any>>("SELECT axis, to_status, actor_kind FROM order_status_history WHERE order_id=$1 ORDER BY created_at, ctid", [o.orderId])).rows; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(h.filter((x) => x.axis === 'operational').map((x) => x.to_status)).toEqual(
      ['awaiting_payment', 'pending_acceptance', 'accepted', 'preparing', 'ready', 'delivered']);
    expect(h.find((x) => x.axis === 'payment')).toMatchObject({ to_status: 'approved', actor_kind: 'provider' });
  });
});

describe('errores de negocio', () => {
  it('DomainError conserva un código estable', () => {
    expect(new DomainError('PAUSED').code).toBe('PAUSED');
  });
});
