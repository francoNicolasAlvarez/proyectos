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
  const t = (await one("INSERT INTO tenants (name, slug) VALUES ($1,$2) RETURNING id", ['C' + n, 'cs-' + n])).id as string;
  await pg.query('INSERT INTO tenant_settings (tenant_id) VALUES ($1)', [t]);
  await pg.query("INSERT INTO tenant_payment_methods (tenant_id, method, enabled) VALUES ($1,'payment_app',true)", [t]);
  const point = (await one("INSERT INTO pickup_points (tenant_id, name, is_default) VALUES ($1,'Barra',true) RETURNING id", [t])).id as string;
  await pg.query("INSERT INTO menus (tenant_id, name, is_default) VALUES ($1,'Carta',true)", [t]);
  return { id: t, slug: 'cs-' + n, point };
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
    return { status: res.statusCode, body: json };
  }
}
async function user(role?: { tenant: string; role: string }) {
  const c = new Client(); const email = `cg${++seq}@mail.com`;
  const reg = await c.req('POST', '/auth/register', { email, name: 'U', password: 'una-clave-larga', adultDeclared: true });
  await c.req('POST', '/auth/login', { email, password: 'una-clave-larga' });
  if (role) await pg.query('INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)', [role.tenant, reg.body.id, role.role]);
  return { c, id: reg.body.id as string };
}
const sizeGroup = { name: 'Tamaño', minSelect: 1, maxSelect: 1, options: [{ name: 'Pinta', priceDeltaCents: 0 }, { name: 'Jarra', priceDeltaCents: 380000 }] };
const publicMenu = async (slug: string) => (await new Client().req('GET', `/venues/${slug}/menu`)).body;
let k = 0;

/** Un local con un gerente y una categoría ya creada. */
async function setup() {
  const s = await seedTenant(); const mgr = await user({ tenant: s.id, role: 'manager' });
  const cat = (await mgr.c.req('POST', `/venues/${s.slug}/staff/categories`, { name: 'Cervezas' })).body;
  const base = `/venues/${s.slug}/staff`;
  const product = (over: Record<string, unknown> = {}) => mgr.c.req('POST', `${base}/products`, { categoryId: cat.id, name: 'Rubia', basePriceCents: 420000, prepMinutes: 2, kind: 'simple', ...over });
  return { s, mgr, cat, base, product };
}

describe('categorías', () => {
  it('se crean en el menú habitual, ordenadas, con su cantidad de productos', async () => {
    const { s, mgr, cat, base, product } = await setup();
    const second = (await mgr.c.req('POST', `${base}/categories`, { name: 'Comidas', pickupPointId: s.point })).body;
    expect(cat).toMatchObject({ name: 'Cervezas', sortOrder: 1, paused: false, productCount: 0, archived: false });
    expect(second).toMatchObject({ name: 'Comidas', sortOrder: 2, pickupPointId: s.point });
    await product();
    const list = (await mgr.c.req('GET', `${base}/categories`)).body;
    expect(list.map((c: Row) => [c.name, c.productCount])).toEqual([['Cervezas', 1], ['Comidas', 0]]);
  });

  it.each([
    ['nombre vacío', { name: '   ' }, 422, 'NAME_REQUIRED'],
    ['nombre repetido (sin distinguir mayúsculas)', { name: 'cervezas' }, 409, 'CATEGORY_NAME_TAKEN'],
    ['punto de retiro de otro local', { name: 'Otra', pickupPointId: '00000000-0000-4000-8000-000000000000' }, 422, 'INVALID_PICKUP_POINT'],
    ['campo desconocido', { name: 'X', color: 'rojo' }, 400, 'VALIDATION'],
  ])('rechaza: %s', async (_n, body, status, code) => {
    const { mgr, base } = await setup();
    const r = await mgr.c.req('POST', `${base}/categories`, body);
    expect(r.status).toBe(status);
    expect(r.body.code).toBe(code);
  });

  it('renombrar, reordenar y archivar: una categoría con productos no se archiva; vacía sí, y se puede recuperar', async () => {
    const { mgr, cat, base, product } = await setup();
    expect((await mgr.c.req('PUT', `${base}/categories/${cat.id}`, { name: 'Cervezas artesanales', sortOrder: 5 })).body).toMatchObject({ name: 'Cervezas artesanales', sortOrder: 5 });
    const p = (await product()).body;
    expect((await mgr.c.req('PUT', `${base}/categories/${cat.id}`, { archived: true })).body.code).toBe('CATEGORY_NOT_EMPTY');
    await mgr.c.req('PUT', `${base}/products/${p.id}`, { archived: true });
    expect((await mgr.c.req('PUT', `${base}/categories/${cat.id}`, { archived: true })).body.archived).toBe(true);
    expect((await mgr.c.req('GET', `${base}/categories`)).body).toEqual([]);
    expect((await mgr.c.req('GET', `${base}/categories?archived=1`)).body).toHaveLength(1);
    expect((await mgr.c.req('PUT', `${base}/categories/${cat.id}`, { archived: false })).body.archived).toBe(false);
  });
});

describe('productos: alta y menú', () => {
  it('un producto con variantes aparece en el menú público con sus precios y se puede pedir con el precio correcto', async () => {
    const { s, mgr, product } = await setup();
    const p = (await product({ description: 'Suave', ingredients: 'Malta', groups: [sizeGroup] })).body;
    expect(p).toMatchObject({ name: 'Rubia', basePriceCents: 420000, prepMinutes: 2, kind: 'simple', available: true, archived: false, limitsIssues: [] });
    expect(p.groups[0]).toMatchObject({ name: 'Tamaño', minSelect: 1, maxSelect: 1 });
    expect(p.groups[0].options.map((o: Row) => [o.name, o.priceDeltaCents])).toEqual([['Pinta', 0], ['Jarra', 380000]]);

    const menuProduct = (await publicMenu(s.slug)).categories[0].products[0];
    expect(menuProduct).toMatchObject({ name: 'Rubia', priceCents: 420000, description: 'Suave', available: true });

    const cli = await user();
    const jarra = p.groups[0].options.find((o: Row) => o.name === 'Jarra');
    const order = await cli.c.req('POST', `/venues/${s.slug}/orders`, { paymentMethod: 'payment_app', items: [{ productId: p.id, quantity: 2, selections: { [p.groups[0].id]: [jarra.id] } }] }, { 'idempotency-key': 'catalogo-test-' + ++k });
    expect(order.status).toBe(201);
    expect(order.body.totalCents).toBe(2 * 800000);                          // (4.200 + 3.800) × 2
  });

  it('un combo con dos ranuras queda marcado como combo en el menú', async () => {
    const { s, mgr, cat, base } = await setup();
    const beers = [{ name: 'Rubia' }, { name: 'IPA', priceDeltaCents: 40000 }];
    const combo = (await mgr.c.req('POST', `${base}/products`, { categoryId: cat.id, name: 'Combo 3', basePriceCents: 1190000, prepMinutes: 12, kind: 'combo',
      groups: [{ name: 'Cerveza 1', minSelect: 1, maxSelect: 1, options: beers }, { name: 'Cerveza 2', minSelect: 1, maxSelect: 1, options: beers }] })).body;
    expect(combo.kind).toBe('combo');
    expect(combo.groups).toHaveLength(2);
    const m = (await publicMenu(s.slug)).categories[0].products.find((p: Row) => p.name === 'Combo 3');
    expect(m).toMatchObject({ kind: 'combo', priceCents: 1190000 });
  });

  it('el mismo nombre se permite en otra categoría pero no dos veces en la misma', async () => {
    const { mgr, cat, base, product } = await setup();
    await product();
    expect((await product()).body.code).toBe('PRODUCT_NAME_TAKEN');
    expect((await product({ name: 'RUBIA' })).body.code).toBe('PRODUCT_NAME_TAKEN');
    const other = (await mgr.c.req('POST', `${base}/categories`, { name: 'Tragos' })).body;
    expect((await mgr.c.req('POST', `${base}/products`, { categoryId: other.id, name: 'Rubia', basePriceCents: 1, prepMinutes: 1, kind: 'simple' })).status).toBe(201);
    void cat;
  });

  it('producto sin variantes y precio cero son válidos (por ejemplo, un agua de cortesía)', async () => {
    const { product } = await setup();
    const r = await product({ name: 'Agua', basePriceCents: 0, prepMinutes: 0 });
    expect(r.status).toBe(201);
    expect(r.body.groups).toEqual([]);
  });
});

describe('productos: validaciones (escenario → resultado esperado)', () => {
  const bad = (over: Record<string, unknown>) => over;
  it.each([
    ['nombre vacío', bad({ name: '  ' }), 422, 'NAME_REQUIRED'],
    ['precio negativo', bad({ basePriceCents: -1 }), 422, 'INVALID_PRICE'],
    ['precio con decimales', bad({ basePriceCents: 10.5 }), 400, 'VALIDATION'],
    ['precio absurdo', bad({ basePriceCents: 10_000_000_000_000 }), 422, 'INVALID_PRICE'],
    ['tiempo de preparación mayor a 240 minutos', bad({ prepMinutes: 241 }), 422, 'INVALID_PREP_TIME'],
    ['tipo de producto inventado', bad({ kind: 'regalo' }), 400, 'VALIDATION'],
    ['categoría inexistente', bad({ categoryId: '00000000-0000-4000-8000-000000000000' }), 404, 'CATEGORY_NOT_FOUND'],
    ['punto de retiro inexistente', bad({ pickupPointId: '00000000-0000-4000-8000-000000000000' }), 422, 'INVALID_PICKUP_POINT'],
    ['grupo sin nombre', bad({ groups: [{ name: ' ', minSelect: 0, maxSelect: 1, options: [{ name: 'A' }] }] }), 422, 'GROUP_NAME_REQUIRED'],
    ['grupo sin opciones', bad({ groups: [{ name: 'G', minSelect: 0, maxSelect: 1, options: [] }] }), 422, 'GROUP_NEEDS_OPTIONS'],
    ['mínimo mayor que el máximo', bad({ groups: [{ name: 'G', minSelect: 2, maxSelect: 1, options: [{ name: 'A' }, { name: 'B' }] }] }), 422, 'INVALID_GROUP_RANGE'],
    ['máximo cero', bad({ groups: [{ name: 'G', minSelect: 0, maxSelect: 0, options: [{ name: 'A' }] }] }), 422, 'INVALID_GROUP_RANGE'],
    ['mínimo mayor que la cantidad de opciones', bad({ groups: [{ name: 'G', minSelect: 2, maxSelect: 2, options: [{ name: 'A' }] }] }), 422, 'GROUP_MIN_EXCEEDS_OPTIONS'],
    ['grupos con el mismo nombre', bad({ groups: [{ name: 'G', minSelect: 0, maxSelect: 1, options: [{ name: 'A' }] }, { name: 'g', minSelect: 0, maxSelect: 1, options: [{ name: 'A' }] }] }), 422, 'GROUP_NAME_DUPLICATE'],
    ['opciones con el mismo nombre', bad({ groups: [{ name: 'G', minSelect: 0, maxSelect: 2, options: [{ name: 'A' }, { name: 'a' }] }] }), 422, 'OPTION_NAME_DUPLICATE'],
    ['precio de opción con decimales', bad({ groups: [{ name: 'G', minSelect: 0, maxSelect: 1, options: [{ name: 'A', priceDeltaCents: 1.5 }] }] }), 400, 'VALIDATION'],
    ['campo desconocido', bad({ descuento: 50 }), 400, 'VALIDATION'],
  ])('rechaza: %s', async (_n, over, status, code) => {
    const { product } = await setup();
    const r = await product(over);
    expect(r.status).toBe(status);
    expect(r.body.code).toBe(code);
  });

  it('un producto rechazado no deja nada a medias en la base de datos', async () => {
    const { s, product } = await setup();
    await product({ name: 'Mala', groups: [{ name: 'G', minSelect: 0, maxSelect: 1, options: [{ name: 'A' }] }, { name: 'H', minSelect: 0, maxSelect: 1, options: [] }] });
    expect((await one('SELECT count(*)::int n FROM products WHERE tenant_id=$1', [s.id])).n).toBe(0);
    expect((await one('SELECT count(*)::int n FROM option_groups WHERE tenant_id=$1', [s.id])).n).toBe(0);
  });
});

describe('productos: edición, precios y archivo', () => {
  it('cambiar el precio queda auditado con el antes y el después', async () => {
    const { s, mgr, base, product } = await setup();
    const p = (await product()).body;
    const r = await mgr.c.req('PUT', `${base}/products/${p.id}`, { basePriceCents: 460000 });
    expect(r.body.basePriceCents).toBe(460000);
    const log = await one("SELECT actor_user_id, before, after FROM audit_log WHERE tenant_id=$1 AND action='product.price_changed'", [s.id]);
    expect(log.actor_user_id).toBe(mgr.id);
    expect(log.before).toMatchObject({ basePriceCents: 420000 });
    expect(log.after).toMatchObject({ basePriceCents: 460000 });
  });

  it('un precio que hace inalcanzable el tope de 8 combos devuelve un aviso (y subir el tope lo resuelve)', async () => {
    const { s, mgr, cat, base } = await setup();
    const r = await mgr.c.req('POST', `${base}/products`, { categoryId: cat.id, name: 'Combo caro', basePriceCents: 1290000, prepMinutes: 10, kind: 'combo' });
    expect(r.status).toBe(201);
    expect(r.body.limitsIssues).toEqual([{ code: 'COMBO_LIMIT_UNREACHABLE', severity: 'warning', product: 'Combo caro', maxReachable: 7 }]);
    const owner = await user({ tenant: s.id, role: 'owner' });
    await owner.c.req('PUT', `${base}/limits`, { maxTotalCents: 12_000_000 });
    expect((await mgr.c.req('PUT', `${base}/products/${r.body.id}`, { prepMinutes: 11 })).body.limitsIssues).toEqual([]);
  });

  it('reemplazar las variantes cambia el menú y no altera los pedidos ya hechos', async () => {
    const { s, mgr, base, product } = await setup();
    const p = (await product({ groups: [sizeGroup] })).body;
    const cli = await user();
    const order = await cli.c.req('POST', `/venues/${s.slug}/orders`, { paymentMethod: 'payment_app', items: [{ productId: p.id, quantity: 1, selections: { [p.groups[0].id]: [p.groups[0].options[1].id] } }] }, { 'idempotency-key': 'catalogo-test-' + ++k });
    const upd = await mgr.c.req('PUT', `${base}/products/${p.id}`, { groups: [{ name: 'Sabor', minSelect: 0, maxSelect: 1, options: [{ name: 'Clásica' }] }] });
    expect(upd.body.groups.map((g: Row) => g.name)).toEqual(['Sabor']);
    expect(upd.body.groups[0].id).not.toBe(p.groups[0].id);
    const items = (await pg.query<Row>('SELECT name_snapshot, unit_price_cents FROM order_items WHERE order_id=$1', [order.body.orderId])).rows;
    expect(items.map((i) => [i.name_snapshot, Number(i.unit_price_cents)])).toEqual([['Rubia', 800000]]);     // la copia del pedido no cambió
    expect((await one("SELECT name_snapshot FROM order_item_selections WHERE name_snapshot='Jarra'")).name_snapshot).toBe('Jarra');
  });

  it('archivar saca el producto del menú y de los pedidos; desarchivar lo devuelve', async () => {
    const { s, mgr, base, product } = await setup();
    const p = (await product()).body; const cli = await user();
    const order = () => cli.c.req('POST', `/venues/${s.slug}/orders`, { paymentMethod: 'payment_app', items: [{ productId: p.id, quantity: 1, selections: {} }] }, { 'idempotency-key': 'catalogo-test-' + ++k });
    await mgr.c.req('PUT', `${base}/products/${p.id}`, { archived: true });
    expect((await publicMenu(s.slug)).categories[0].products).toEqual([]);
    expect((await order()).body.code).toBe('PRODUCT_UNAVAILABLE');
    expect((await mgr.c.req('GET', `${base}/products`)).body).toEqual([]);
    expect((await mgr.c.req('GET', `${base}/products?archived=1`)).body).toHaveLength(1);
    await mgr.c.req('PUT', `${base}/products/${p.id}`, { archived: false });
    expect((await publicMenu(s.slug)).categories[0].products).toHaveLength(1);
    expect((await order()).status).toBe(201);
    expect((await one("SELECT count(*)::int n FROM audit_log WHERE tenant_id=$1 AND action='product.archive_changed'", [s.id])).n).toBe(2);
  });

  it('mover un producto a otra categoría y cambiar su punto de retiro', async () => {
    const { s, mgr, base, product } = await setup();
    const p = (await product()).body;
    const food = (await mgr.c.req('POST', `${base}/categories`, { name: 'Comidas' })).body;
    const moved = (await mgr.c.req('PUT', `${base}/products/${p.id}`, { categoryId: food.id, pickupPointId: s.point })).body;
    expect(moved).toMatchObject({ categoryId: food.id, pickupPointId: s.point });
    expect((await publicMenu(s.slug)).categories.map((c: Row) => [c.name, c.products.length])).toEqual([['Cervezas', 0], ['Comidas', 1]]);
  });

  it('editar solo algunos campos no toca los demás', async () => {
    const { mgr, base, product } = await setup();
    const p = (await product({ description: 'Suave', groups: [sizeGroup] })).body;
    const r = (await mgr.c.req('PUT', `${base}/products/${p.id}`, { prepMinutes: 5 })).body;
    expect(r).toMatchObject({ name: 'Rubia', description: 'Suave', basePriceCents: 420000, prepMinutes: 5 });
    expect(r.groups).toHaveLength(1);
    expect((await mgr.c.req('PUT', `${base}/products/${p.id}`, { description: null })).body.description).toBeNull();
  });
});

describe('catálogo: permisos y aislamiento entre locales', () => {
  it('solo gerente y dueño; el resto, no; sin sesión 401', async () => {
    const { s, cat, base, product } = await setup();
    const ops = await user({ tenant: s.id, role: 'order_operator' }); const door = await user({ tenant: s.id, role: 'pickup_operator' });
    const owner = await user({ tenant: s.id, role: 'owner' }); const customer = await user();
    const p = (await product()).body;
    for (const u of [ops, door, customer]) {
      expect((await u.c.req('GET', `${base}/products`)).status).toBe(403);
      expect((await u.c.req('POST', `${base}/products`, { categoryId: cat.id, name: 'X', basePriceCents: 1, prepMinutes: 1, kind: 'simple' })).status).toBe(403);
      expect((await u.c.req('PUT', `${base}/products/${p.id}`, { basePriceCents: 1 })).status).toBe(403);
      expect((await u.c.req('POST', `${base}/categories`, { name: 'X' })).status).toBe(403);
    }
    expect((await owner.c.req('GET', `${base}/products`)).status).toBe(200);
    expect((await new Client().req('GET', `${base}/products`)).status).toBe(401);
    expect((await one('SELECT base_price_cents FROM products WHERE id=$1', [p.id])).base_price_cents).toEqual(420000);
  });

  it('un local no ve ni modifica el catálogo de otro, aunque conozca los ids', async () => {
    const a = await setup(); const b = await setup();
    const ownerB = await user({ tenant: b.s.id, role: 'owner' });
    const pa = (await a.product()).body;
    expect((await ownerB.c.req('GET', `/venues/${a.s.slug}/staff/products`)).status).toBe(403);
    expect((await ownerB.c.req('PUT', `/venues/${b.s.slug}/staff/products/${pa.id}`, { basePriceCents: 1 })).body.code).toBe('PRODUCT_NOT_FOUND');
    expect((await ownerB.c.req('PUT', `/venues/${b.s.slug}/staff/categories/${a.cat.id}`, { name: 'Hack' })).body.code).toBe('CATEGORY_NOT_FOUND');
    expect((await ownerB.c.req('POST', `/venues/${b.s.slug}/staff/products`, { categoryId: a.cat.id, name: 'Intruso', basePriceCents: 1, prepMinutes: 1, kind: 'simple' })).body.code).toBe('CATEGORY_NOT_FOUND');
    expect((await one('SELECT count(*)::int n FROM products WHERE tenant_id=$1', [b.s.id])).n).toBe(0);
  });
});
