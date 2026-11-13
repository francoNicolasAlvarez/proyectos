import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { withContext, type Database, type RequestContext } from '../src/db';
import { resolveActiveMenu, resolveTenantBySlug } from '../src/menu';
import { createOrder, markPaymentApproved, markPartReady, transitionOrder } from '../src/order-service';
import { getCustomerOrder, getPublicMenu, getVenueQueue } from '../src/read-models';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const SECRET = 's';
const ROLE = 'app_runtime';
let pg: PGlite;
let db: Database;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync(fileURLToPath(new URL('../db/migrations/0001_init.sql', import.meta.url)), 'utf8'));
  db = pg as unknown as Database;
});
const one = async (sql: string, p: unknown[] = []) => (await pg.query<Row>(sql, p)).rows[0] as Row;
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code?: string }).code ?? (e as Error).message; } return null; };

interface Seed { id: string; slug: string; customer: string; staff: string; regularProduct: string; regularCat: string; beer: { group: string; pint: string; liter: string }; eventProduct: string; eventId: string; eventMenu: string; defaultMenu: string }
let seq = 0;
async function seedTenant(): Promise<Seed> {
  const n = ++seq;
  const slug = 'Menu-Bar-' + n;
  const t = (await one("INSERT INTO tenants (name, slug) VALUES ($1,$2) RETURNING id", ['Bar ' + n, slug])).id;
  const customer = (await one("INSERT INTO users (email, name) VALUES ($1,'C') RETURNING id", [`mc${n}@x.com`])).id;
  const staff = (await one("INSERT INTO users (email, name) VALUES ($1,'S') RETURNING id", [`ms${n}@x.com`])).id;
  await pg.query('INSERT INTO tenant_settings (tenant_id, pickup_mode) VALUES ($1, $2)', [t, 'single_point']);
  await pg.query("INSERT INTO tenant_payment_methods (tenant_id, method, enabled) VALUES ($1,'payment_app',true)", [t]);
  const barra = (await one("INSERT INTO pickup_points (tenant_id, name, is_default) VALUES ($1,'Barra 1',true) RETURNING id", [t])).id;
  const defaultMenu = (await one("INSERT INTO menus (tenant_id, name, is_default) VALUES ($1,'Carta',true) RETURNING id", [t])).id;
  const regularCat = (await one("INSERT INTO categories (tenant_id, menu_id, name, sort_order, pickup_point_id) VALUES ($1,$2,'Cervezas',1,$3) RETURNING id", [t, defaultMenu, barra])).id;
  const regularProduct = (await one("INSERT INTO products (tenant_id, category_id, name, description, base_price_cents, prep_minutes) VALUES ($1,$2,'Rubia','Suave',420000,2) RETURNING id", [t, regularCat])).id;
  await pg.query("INSERT INTO products (tenant_id, category_id, name, base_price_cents, archived_at) VALUES ($1,$2,'Vieja',1,now())", [t, regularCat]);
  const g = (await one("INSERT INTO option_groups (tenant_id, product_id, name, min_select, max_select) VALUES ($1,$2,'Tamaño',1,1) RETURNING id", [t, regularProduct])).id;
  const pint = (await one("INSERT INTO options (tenant_id, group_id, name, price_delta_cents, sort_order) VALUES ($1,$2,'Pinta',0,1) RETURNING id", [t, g])).id;
  const liter = (await one("INSERT INTO options (tenant_id, group_id, name, price_delta_cents, sort_order) VALUES ($1,$2,'Jarra',380000,2) RETURNING id", [t, g])).id;
  // Evento con menú propio (publicado, ventana de pedidos 20:00–23:00 UTC del 2031-01-10)
  const eventId = (await one(
    "INSERT INTO events (tenant_id, name, starts_at, ends_at, orders_open_at, orders_close_at, status) VALUES ($1,'Festival','2031-01-10T19:00:00Z','2031-01-11T03:00:00Z','2031-01-10T20:00:00Z','2031-01-10T23:00:00Z','published') RETURNING id", [t])).id;
  const eventMenu = (await one("INSERT INTO menus (tenant_id, name, kind, event_id) VALUES ($1,'Menú festival','event',$2) RETURNING id", [t, eventId])).id;
  const eventCat = (await one("INSERT INTO categories (tenant_id, menu_id, name, pickup_point_id) VALUES ($1,$2,'Festival',$3) RETURNING id", [t, eventMenu, barra])).id;
  const eventProduct = (await one("INSERT INTO products (tenant_id, category_id, name, base_price_cents) VALUES ($1,$2,'Choripán',300000) RETURNING id", [t, eventCat])).id;
  return { id: t, slug, customer, staff, regularProduct, regularCat, beer: { group: g, pint, liter }, eventProduct, eventId, eventMenu, defaultMenu };
}
const ctx = (s: Seed, who: 'customer' | 'staff' | 'public' = 'public'): RequestContext =>
  ({ tenantId: s.id, userId: who === 'customer' ? s.customer : who === 'staff' ? s.staff : undefined, role: ROLE });
const run = <T>(c: RequestContext, fn: Parameters<typeof withContext<T>>[2]) => withContext(db, c, fn);
let k = 0;
const order = (s: Seed, productId: string, selections: Record<string, string[]>, now?: Date) => run(ctx(s, 'customer'), (tx) =>
  createOrder(tx, { tenantId: s.id, userId: s.customer, idempotencyKey: 'k' + ++k, paymentMethod: 'payment_app', items: [{ productId, quantity: 1, selections }], now }));
const pint = (s: Seed) => ({ [s.beer.group]: [s.beer.pint] });
const DURING = new Date('2031-01-10T21:00:00Z');
const BEFORE = new Date('2031-01-10T19:30:00Z');   // evento empezó, pero aún no abren los pedidos
const AFTER = new Date('2031-01-10T23:30:00Z');

describe('tenant por slug', () => {
  it('resuelve sin distinguir mayúsculas y oculta locales no activos', async () => {
    const s = await seedTenant();
    expect(await run({ role: ROLE }, (tx) => resolveTenantBySlug(tx, s.slug.toUpperCase()))).toMatchObject({ id: s.id });
    expect(await run({ role: ROLE }, (tx) => resolveTenantBySlug(tx, 'no-existe'))).toBeNull();
    await pg.query("UPDATE tenants SET status='suspended' WHERE id=$1", [s.id]);
    expect(await run({ role: ROLE }, (tx) => resolveTenantBySlug(tx, s.slug))).toBeNull();
  });
});

describe('menú público', () => {
  it('devuelve el menú habitual con categorías, productos, variantes y disponibilidad', async () => {
    const s = await seedTenant();
    const m = await run(ctx(s), (tx) => getPublicMenu(tx, s.id));
    expect(m).toMatchObject({ menuId: s.defaultMenu, eventId: null, paused: false });
    expect(m.categories.map((c) => c.name)).toEqual(['Cervezas']);
    const p = m.categories[0]?.products ?? [];
    expect(p.map((x) => x.name)).toEqual(['Rubia']);          // el archivado no aparece
    expect(p[0]).toMatchObject({ priceCents: 420000, prepMinutes: 2, available: true, description: 'Suave' });
    expect(p[0]?.groups[0]).toMatchObject({ name: 'Tamaño', min: 1, max: 1 });
    expect(p[0]?.groups[0]?.options.map((o) => [o.name, o.priceDeltaCents])).toEqual([['Pinta', 0], ['Jarra', 380000]]);
  });

  it('una categoría pausada marca sus productos como no disponibles y se informa la pausa general', async () => {
    const s = await seedTenant();
    await pg.query('UPDATE categories SET paused = true WHERE id=$1', [s.regularCat]);
    await pg.query("UPDATE tenant_settings SET ordering_paused = true, pause_message = 'Volvemos en 10 min' WHERE tenant_id=$1", [s.id]);
    const m = await run(ctx(s), (tx) => getPublicMenu(tx, s.id));
    expect(m.categories[0]?.products[0]?.available).toBe(false);
    expect(m).toMatchObject({ paused: true, pauseMessage: 'Volvemos en 10 min' });
  });

  it('no mezcla datos de otro local', async () => {
    const a = await seedTenant(); const b = await seedTenant();
    const m = await run(ctx(a), (tx) => getPublicMenu(tx, a.id));
    const ids = m.categories.flatMap((c) => c.products.map((p) => p.id));
    expect(ids).toContain(a.regularProduct);
    expect(ids).not.toContain(b.regularProduct);
  });
});

describe('menú de evento', () => {
  it('reemplaza al habitual solo dentro de la ventana de pedidos del evento', async () => {
    const s = await seedTenant();
    const at = (d: Date) => run(ctx(s), (tx) => resolveActiveMenu(tx, s.id, d));
    expect(await at(BEFORE)).toEqual({ menuId: s.defaultMenu, eventId: null });
    expect(await at(DURING)).toEqual({ menuId: s.eventMenu, eventId: s.eventId });
    expect(await at(AFTER)).toEqual({ menuId: s.defaultMenu, eventId: null });
    const menu = await run(ctx(s), (tx) => getPublicMenu(tx, s.id, DURING));
    expect(menu.categories.map((c) => c.name)).toEqual(['Festival']);
    expect(menu.eventId).toBe(s.eventId);
  });

  it('un evento en borrador o cerrado no activa su menú', async () => {
    const s = await seedTenant();
    for (const status of ['draft', 'closed']) {
      await pg.query('UPDATE events SET status=$2 WHERE id=$1', [s.eventId, status]);
      expect((await run(ctx(s), (tx) => resolveActiveMenu(tx, s.id, DURING)))?.menuId).toBe(s.defaultMenu);
    }
  });

  it('solo se puede pedir del menú vigente y el pedido queda asociado al evento', async () => {
    const s = await seedTenant();
    expect(await code(order(s, s.regularProduct, pint(s), DURING))).toBe('PRODUCT_NOT_IN_ACTIVE_MENU');
    expect(await code(order(s, s.eventProduct, {}, BEFORE))).toBe('PRODUCT_NOT_IN_ACTIVE_MENU');
    expect(await code(order(s, s.eventProduct, {}, AFTER))).toBe('PRODUCT_NOT_IN_ACTIVE_MENU');

    const ok = await order(s, s.eventProduct, {}, DURING);
    expect((await one('SELECT event_id FROM orders WHERE id=$1', [ok.orderId])).event_id).toBe(s.eventId);
    const regular = await order(s, s.regularProduct, pint(s), AFTER);
    expect((await one('SELECT event_id FROM orders WHERE id=$1', [regular.orderId])).event_id).toBeNull();
  });
});

describe('cola del local', () => {
  async function paid(s: Seed, items = 1) {
    const o = await order(s, s.regularProduct, { [s.beer.group]: [s.beer.liter] });
    await run(ctx(s), (tx) => markPaymentApproved(tx, { tenantId: s.id, orderId: o.orderId, provider: 'mp', providerPaymentId: 'P' + ++k, amountCents: o.totalCents }));
    void items; return o;
  }

  it('muestra solo pedidos pagados y abiertos, del más antiguo al más nuevo, con ítems y variantes', async () => {
    const s = await seedTenant();
    const first = await paid(s);
    const second = await paid(s);
    await order(s, s.regularProduct, pint(s));                       // sin pagar: no aparece
    const delivered = await paid(s);
    await pg.query("UPDATE orders SET operational_status='delivered' WHERE id=$1", [delivered.orderId]);
    const queue = await run(ctx(s, 'staff'), (tx) => getVenueQueue(tx, s.id));
    expect(queue.map((q) => q.id)).toEqual([first.orderId, second.orderId]);
    expect(queue[0]).toMatchObject({ number: first.orderNumber, status: 'pending_acceptance', paymentStatus: 'approved' });
    expect(queue[0]?.parts[0]?.items[0]).toMatchObject({ name: 'Rubia', quantity: 1, detail: 'Tamaño: Jarra' });
  });

  it('no incluye pedidos de otros locales', async () => {
    const a = await seedTenant(); const b = await seedTenant();
    await paid(b);
    expect(await run(ctx(a, 'staff'), (tx) => getVenueQueue(tx, a.id))).toEqual([]);
    expect(await run(ctx(a, 'staff'), (tx) => getVenueQueue(tx, b.id))).toEqual([]);   // ni pidiéndolo explícitamente
  });

  it('una cola vacía devuelve una lista vacía', async () => {
    const s = await seedTenant();
    expect(await run(ctx(s, 'staff'), (tx) => getVenueQueue(tx, s.id))).toEqual([]);
  });
});

describe('seguimiento del cliente', () => {
  it('muestra el QR solo cuando la parte está lista y solo a su dueño', async () => {
    const s = await seedTenant();
    const o = await order(s, s.regularProduct, pint(s));
    await run(ctx(s), (tx) => markPaymentApproved(tx, { tenantId: s.id, orderId: o.orderId, provider: 'mp', providerPaymentId: 'Q' + ++k, amountCents: o.totalCents }));
    const mine = { tenantId: s.id, userId: s.customer, role: ROLE };

    let view = await run(mine, (tx) => getCustomerOrder(tx, { orderId: o.orderId, userId: s.customer, secret: SECRET }));
    expect(view).toMatchObject({ number: 1, status: 'pending_acceptance', originName: null });
    expect(view?.parts[0]?.pickup).toBeNull();

    await run(ctx(s, 'staff'), (tx) => transitionOrder(tx, { tenantId: s.id, orderId: o.orderId, to: 'accepted', actor: 'staff', actorUserId: s.staff }));
    await run(ctx(s, 'staff'), (tx) => transitionOrder(tx, { tenantId: s.id, orderId: o.orderId, to: 'preparing', actor: 'staff', actorUserId: s.staff }));
    const partId = (await one('SELECT id FROM order_parts WHERE order_id=$1', [o.orderId])).id;
    const issued = await run(ctx(s, 'staff'), (tx) => markPartReady(tx, { tenantId: s.id, partId, staffUserId: s.staff, secret: SECRET }));

    view = await run(mine, (tx) => getCustomerOrder(tx, { orderId: o.orderId, userId: s.customer, secret: SECRET }));
    expect(view?.status).toBe('ready');
    expect(view?.parts[0]).toMatchObject({ status: 'ready', pickupPoint: 'Barra 1', pickup: { token: issued.token, shortCode: issued.shortCode, used: false } });

    const stranger = (await one("INSERT INTO users (email, name) VALUES ('ajeno@x.com','A') RETURNING id")).id;
    // Aun con contexto del local (RLS lo dejaría ver), otro cliente no puede ver el pedido ni cancelarlo.
    const strangerCtx = { tenantId: s.id, userId: stranger, role: ROLE };
    expect(await run(strangerCtx, (tx) => getCustomerOrder(tx, { orderId: o.orderId, userId: stranger, secret: SECRET }))).toBeNull();
  });
});
