/**
 * Administración del catálogo del local: categorías, productos, variantes (grupos de opciones) y combos.
 * Reglas: los productos no se borran, se archivan (los pedidos viejos guardan su propia copia, pero el historial no debe perder la referencia);
 * los grupos de opciones se reemplazan completos al editar; cada cambio de precio queda auditado con el antes y el después.
 */
import { DomainError, num, type Queryable } from './db';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface OptionInput { name: string; priceDeltaCents?: number; available?: boolean }
export interface GroupInput { name: string; minSelect: number; maxSelect: number; options: OptionInput[] }
export interface ProductFields {
  name: string; description?: string | null; ingredients?: string | null; imageUrl?: string | null;
  basePriceCents: number; prepMinutes: number; kind: 'simple' | 'combo'; pickupPointId?: string | null; available?: boolean;
}

export interface OptionView { id: string; name: string; priceDeltaCents: number; available: boolean }
export interface GroupView { id: string; name: string; minSelect: number; maxSelect: number; options: OptionView[] }
export interface ProductView {
  id: string; categoryId: string; name: string; description: string | null; ingredients: string | null; imageUrl: string | null;
  basePriceCents: number; prepMinutes: number; kind: 'simple' | 'combo'; available: boolean; pickupPointId: string | null; archived: boolean; groups: GroupView[];
}
export interface CategoryView { id: string; menuId: string; name: string; sortOrder: number; paused: boolean; pickupPointId: string | null; archived: boolean; productCount: number }

const MAX_PRICE_CENTS = 1_000_000_000_000;

const audit = (tx: Queryable, p: { tenantId: string; actorUserId: string; action: string; entity: string; entityId: string; before?: unknown; after?: unknown }) =>
  tx.query('INSERT INTO audit_log (tenant_id, actor_user_id, action, entity, entity_id, before, after) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [p.tenantId, p.actorUserId, p.action, p.entity, p.entityId, p.before === undefined ? null : JSON.stringify(p.before), p.after === undefined ? null : JSON.stringify(p.after)]);

function validateFields(f: Partial<ProductFields>, partial: boolean) {
  if (!partial || f.name !== undefined) { if (!f.name || !f.name.trim()) throw new DomainError('NAME_REQUIRED'); if (f.name.trim().length > 120) throw new DomainError('NAME_TOO_LONG'); }
  if (!partial || f.basePriceCents !== undefined) {
    if (!Number.isInteger(f.basePriceCents) || (f.basePriceCents as number) < 0 || (f.basePriceCents as number) > MAX_PRICE_CENTS) throw new DomainError('INVALID_PRICE');
  }
  if (!partial || f.prepMinutes !== undefined) { if (!Number.isInteger(f.prepMinutes) || (f.prepMinutes as number) < 0 || (f.prepMinutes as number) > 240) throw new DomainError('INVALID_PREP_TIME'); }
}

export function validateGroups(groups: readonly GroupInput[]): void {
  const names = new Set<string>();
  for (const g of groups) {
    const gn = g.name?.trim();
    if (!gn) throw new DomainError('GROUP_NAME_REQUIRED');
    if (names.has(gn.toLowerCase())) throw new DomainError('GROUP_NAME_DUPLICATE');
    names.add(gn.toLowerCase());
    if (!Number.isInteger(g.minSelect) || !Number.isInteger(g.maxSelect) || g.minSelect < 0 || g.maxSelect < 1 || g.minSelect > g.maxSelect) throw new DomainError('INVALID_GROUP_RANGE');
    if (!g.options.length) throw new DomainError('GROUP_NEEDS_OPTIONS');
    if (g.minSelect > g.options.length) throw new DomainError('GROUP_MIN_EXCEEDS_OPTIONS');
    const opts = new Set<string>();
    for (const o of g.options) {
      const on = o.name?.trim();
      if (!on) throw new DomainError('OPTION_NAME_REQUIRED');
      if (opts.has(on.toLowerCase())) throw new DomainError('OPTION_NAME_DUPLICATE');
      opts.add(on.toLowerCase());
      const d = o.priceDeltaCents ?? 0;
      if (!Number.isInteger(d) || Math.abs(d) > MAX_PRICE_CENTS) throw new DomainError('INVALID_OPTION_PRICE');
    }
  }
}

async function assertCategory(tx: Queryable, tenantId: string, categoryId: string) {
  const c = (await tx.query<Row>('SELECT id FROM categories WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL', [tenantId, categoryId])).rows[0];
  if (!c) throw new DomainError('CATEGORY_NOT_FOUND');
}
async function assertPickupPoint(tx: Queryable, tenantId: string, pointId: string | null | undefined) {
  if (!pointId) return;
  const r = await tx.query('SELECT 1 FROM pickup_points WHERE tenant_id=$1 AND id=$2 AND active', [tenantId, pointId]);
  if (!r.rows.length) throw new DomainError('INVALID_PICKUP_POINT');
}

async function writeGroups(tx: Queryable, tenantId: string, productId: string, groups: readonly GroupInput[]) {
  let gi = 0;
  for (const g of groups) {
    const gid = (await tx.query<Row>('INSERT INTO option_groups (tenant_id, product_id, name, min_select, max_select, sort_order) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [tenantId, productId, g.name.trim(), g.minSelect, g.maxSelect, ++gi])).rows[0]?.id;
    let oi = 0;
    for (const o of g.options) {
      await tx.query('INSERT INTO options (tenant_id, group_id, name, price_delta_cents, available, sort_order) VALUES ($1,$2,$3,$4,$5,$6)',
        [tenantId, gid, o.name.trim(), o.priceDeltaCents ?? 0, o.available ?? true, ++oi]);
    }
  }
}

export async function loadProduct(tx: Queryable, tenantId: string, productId: string): Promise<ProductView> {
  const p = (await tx.query<Row>('SELECT * FROM products WHERE tenant_id=$1 AND id=$2', [tenantId, productId])).rows[0];
  if (!p) throw new DomainError('PRODUCT_NOT_FOUND');
  const rows = (await tx.query<Row>(
    `SELECT g.id gid, g.name gname, g.min_select, g.max_select, o.id oid, o.name oname, o.price_delta_cents, o.available
     FROM option_groups g LEFT JOIN options o ON o.tenant_id=g.tenant_id AND o.group_id=g.id WHERE g.tenant_id=$1 AND g.product_id=$2 ORDER BY g.sort_order, o.sort_order`, [tenantId, productId])).rows;
  const groups = new Map<string, GroupView>();
  for (const r of rows) {
    let g = groups.get(r.gid);
    if (!g) { g = { id: r.gid, name: r.gname, minSelect: num(r.min_select), maxSelect: num(r.max_select), options: [] }; groups.set(r.gid, g); }
    if (r.oid) g.options.push({ id: r.oid, name: r.oname, priceDeltaCents: num(r.price_delta_cents), available: r.available });
  }
  return {
    id: p.id, categoryId: p.category_id, name: p.name, description: p.description ?? null, ingredients: p.ingredients ?? null, imageUrl: p.image_url ?? null,
    basePriceCents: num(p.base_price_cents), prepMinutes: num(p.prep_minutes), kind: p.kind, available: p.available, pickupPointId: p.pickup_point_id ?? null,
    archived: p.archived_at != null, groups: [...groups.values()],
  };
}

export async function listProducts(tx: Queryable, tenantId: string, opts: { includeArchived?: boolean } = {}): Promise<ProductView[]> {
  const ids = (await tx.query<Row>(`SELECT id FROM products WHERE tenant_id=$1 ${opts.includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY sort_order, name`, [tenantId])).rows;
  const out: ProductView[] = [];
  for (const r of ids) out.push(await loadProduct(tx, tenantId, r.id));
  return out;
}

export async function createProduct(tx: Queryable, p: { tenantId: string; actorUserId: string; categoryId: string; fields: ProductFields; groups?: GroupInput[] }): Promise<ProductView> {
  validateFields(p.fields, false);
  validateGroups(p.groups ?? []);
  await assertCategory(tx, p.tenantId, p.categoryId);
  await assertPickupPoint(tx, p.tenantId, p.fields.pickupPointId);
  const dup = await tx.query('SELECT 1 FROM products WHERE tenant_id=$1 AND category_id=$2 AND archived_at IS NULL AND lower(name)=lower($3)', [p.tenantId, p.categoryId, p.fields.name.trim()]);
  if (dup.rows.length) throw new DomainError('PRODUCT_NAME_TAKEN');
  const sort = num((await tx.query<Row>('SELECT coalesce(max(sort_order),0)+1 n FROM products WHERE tenant_id=$1 AND category_id=$2', [p.tenantId, p.categoryId])).rows[0]?.n);
  const f = p.fields;
  const id = (await tx.query<Row>(
    `INSERT INTO products (tenant_id, category_id, name, description, ingredients, image_url, base_price_cents, prep_minutes, kind, available, pickup_point_id, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [p.tenantId, p.categoryId, f.name.trim(), f.description?.trim() || null, f.ingredients?.trim() || null, f.imageUrl ?? null, f.basePriceCents, f.prepMinutes, f.kind, f.available ?? true, f.pickupPointId ?? null, sort])).rows[0]?.id as string;
  await writeGroups(tx, p.tenantId, id, p.groups ?? []);
  await audit(tx, { tenantId: p.tenantId, actorUserId: p.actorUserId, action: 'product.created', entity: 'product', entityId: id, after: { name: f.name.trim(), basePriceCents: f.basePriceCents, kind: f.kind } });
  return loadProduct(tx, p.tenantId, id);
}

export interface ProductPatch extends Partial<ProductFields> { categoryId?: string; archived?: boolean; groups?: GroupInput[] }

export async function updateProduct(tx: Queryable, p: { tenantId: string; actorUserId: string; productId: string; patch: ProductPatch }): Promise<ProductView> {
  const cur = (await tx.query<Row>('SELECT * FROM products WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [p.tenantId, p.productId])).rows[0];
  if (!cur) throw new DomainError('PRODUCT_NOT_FOUND');
  const patch = p.patch;
  validateFields(patch, true);
  if (patch.groups) validateGroups(patch.groups);
  if (patch.categoryId) await assertCategory(tx, p.tenantId, patch.categoryId);
  if (patch.pickupPointId !== undefined) await assertPickupPoint(tx, p.tenantId, patch.pickupPointId);

  const next = {
    categoryId: patch.categoryId ?? cur.category_id,
    name: patch.name === undefined ? cur.name : patch.name.trim(),
    description: patch.description === undefined ? cur.description : (patch.description?.trim() || null),
    ingredients: patch.ingredients === undefined ? cur.ingredients : (patch.ingredients?.trim() || null),
    imageUrl: patch.imageUrl === undefined ? cur.image_url : patch.imageUrl,
    basePriceCents: patch.basePriceCents ?? num(cur.base_price_cents),
    prepMinutes: patch.prepMinutes ?? num(cur.prep_minutes),
    kind: patch.kind ?? cur.kind,
    available: patch.available ?? cur.available,
    pickupPointId: patch.pickupPointId === undefined ? cur.pickup_point_id : patch.pickupPointId,
  };
  const archivedNow = patch.archived === undefined ? cur.archived_at != null : patch.archived;
  if ((next.categoryId !== cur.category_id || next.name.toLowerCase() !== String(cur.name).toLowerCase()) && !archivedNow) {
    const dup = await tx.query('SELECT 1 FROM products WHERE tenant_id=$1 AND category_id=$2 AND archived_at IS NULL AND lower(name)=lower($3) AND id<>$4', [p.tenantId, next.categoryId, next.name, p.productId]);
    if (dup.rows.length) throw new DomainError('PRODUCT_NAME_TAKEN');
  }
  await tx.query(
    `UPDATE products SET category_id=$3, name=$4, description=$5, ingredients=$6, image_url=$7, base_price_cents=$8, prep_minutes=$9, kind=$10, available=$11, pickup_point_id=$12,
       archived_at = CASE WHEN $13::boolean THEN COALESCE(archived_at, now()) ELSE NULL END WHERE tenant_id=$1 AND id=$2`,
    [p.tenantId, p.productId, next.categoryId, next.name, next.description, next.ingredients, next.imageUrl, next.basePriceCents, next.prepMinutes, next.kind, next.available, next.pickupPointId, archivedNow]);
  if (patch.groups) {
    await tx.query('DELETE FROM options WHERE tenant_id=$1 AND group_id IN (SELECT id FROM option_groups WHERE tenant_id=$1 AND product_id=$2)', [p.tenantId, p.productId]);
    await tx.query('DELETE FROM option_groups WHERE tenant_id=$1 AND product_id=$2', [p.tenantId, p.productId]);
    await writeGroups(tx, p.tenantId, p.productId, patch.groups);
  }
  const priceChanged = next.basePriceCents !== num(cur.base_price_cents);
  await audit(tx, {
    tenantId: p.tenantId, actorUserId: p.actorUserId, action: priceChanged ? 'product.price_changed' : (patch.archived !== undefined ? 'product.archive_changed' : 'product.updated'),
    entity: 'product', entityId: p.productId,
    before: { name: cur.name, basePriceCents: num(cur.base_price_cents), archived: cur.archived_at != null }, after: { name: next.name, basePriceCents: next.basePriceCents, archived: archivedNow },
  });
  return loadProduct(tx, p.tenantId, p.productId);
}

/* ---------- categorías ---------- */

export async function listCategories(tx: Queryable, tenantId: string, opts: { includeArchived?: boolean } = {}): Promise<CategoryView[]> {
  const r = await tx.query<Row>(
    `SELECT c.*, (SELECT count(*)::int FROM products p WHERE p.tenant_id=c.tenant_id AND p.category_id=c.id AND p.archived_at IS NULL) AS product_count
     FROM categories c WHERE c.tenant_id=$1 ${opts.includeArchived ? '' : 'AND c.archived_at IS NULL'} ORDER BY c.sort_order, c.name`, [tenantId]);
  return r.rows.map((c) => ({ id: c.id, menuId: c.menu_id, name: c.name, sortOrder: num(c.sort_order), paused: c.paused, pickupPointId: c.pickup_point_id ?? null, archived: c.archived_at != null, productCount: num(c.product_count) }));
}

export async function createCategory(tx: Queryable, p: { tenantId: string; actorUserId: string; name: string; pickupPointId?: string | null }): Promise<CategoryView> {
  const name = p.name.trim();
  if (!name) throw new DomainError('NAME_REQUIRED');
  const menu = (await tx.query<Row>('SELECT id FROM menus WHERE tenant_id=$1 AND is_default AND active', [p.tenantId])).rows[0];
  if (!menu) throw new DomainError('NO_ACTIVE_MENU');
  await assertPickupPoint(tx, p.tenantId, p.pickupPointId);
  if ((await tx.query('SELECT 1 FROM categories WHERE tenant_id=$1 AND menu_id=$2 AND archived_at IS NULL AND lower(name)=lower($3)', [p.tenantId, menu.id, name])).rows.length) throw new DomainError('CATEGORY_NAME_TAKEN');
  const sort = num((await tx.query<Row>('SELECT coalesce(max(sort_order),0)+1 n FROM categories WHERE tenant_id=$1 AND menu_id=$2', [p.tenantId, menu.id])).rows[0]?.n);
  const id = (await tx.query<Row>('INSERT INTO categories (tenant_id, menu_id, name, sort_order, pickup_point_id) VALUES ($1,$2,$3,$4,$5) RETURNING id', [p.tenantId, menu.id, name, sort, p.pickupPointId ?? null])).rows[0]?.id as string;
  await audit(tx, { tenantId: p.tenantId, actorUserId: p.actorUserId, action: 'category.created', entity: 'category', entityId: id, after: { name } });
  return (await listCategories(tx, p.tenantId)).find((c) => c.id === id) as CategoryView;
}

export async function updateCategory(tx: Queryable, p: { tenantId: string; actorUserId: string; id: string; patch: { name?: string; sortOrder?: number; pickupPointId?: string | null; archived?: boolean } }): Promise<CategoryView> {
  const cur = (await tx.query<Row>('SELECT * FROM categories WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [p.tenantId, p.id])).rows[0];
  if (!cur) throw new DomainError('CATEGORY_NOT_FOUND');
  const patch = p.patch;
  const name = patch.name === undefined ? cur.name : patch.name.trim();
  if (!name) throw new DomainError('NAME_REQUIRED');
  if (patch.sortOrder !== undefined && (!Number.isInteger(patch.sortOrder) || patch.sortOrder < 0 || patch.sortOrder > 10_000)) throw new DomainError('INVALID_SORT_ORDER');
  if (patch.pickupPointId !== undefined) await assertPickupPoint(tx, p.tenantId, patch.pickupPointId);
  const archived = patch.archived === undefined ? cur.archived_at != null : patch.archived;
  if (archived && cur.archived_at == null) {
    const n = num((await tx.query<Row>('SELECT count(*)::int n FROM products WHERE tenant_id=$1 AND category_id=$2 AND archived_at IS NULL', [p.tenantId, p.id])).rows[0]?.n);
    if (n > 0) throw new DomainError('CATEGORY_NOT_EMPTY');
  }
  if (!archived && name.toLowerCase() !== String(cur.name).toLowerCase()) {
    if ((await tx.query('SELECT 1 FROM categories WHERE tenant_id=$1 AND menu_id=$2 AND archived_at IS NULL AND lower(name)=lower($3) AND id<>$4', [p.tenantId, cur.menu_id, name, p.id])).rows.length) throw new DomainError('CATEGORY_NAME_TAKEN');
  }
  await tx.query(
    `UPDATE categories SET name=$3, sort_order=$4, pickup_point_id=$5, archived_at = CASE WHEN $6::boolean THEN COALESCE(archived_at, now()) ELSE NULL END WHERE tenant_id=$1 AND id=$2`,
    [p.tenantId, p.id, name, patch.sortOrder ?? num(cur.sort_order), patch.pickupPointId === undefined ? cur.pickup_point_id : patch.pickupPointId, archived]);
  await audit(tx, { tenantId: p.tenantId, actorUserId: p.actorUserId, action: 'category.updated', entity: 'category', entityId: p.id, before: { name: cur.name, archived: cur.archived_at != null }, after: { name, archived } });
  return (await listCategories(tx, p.tenantId, { includeArchived: true })).find((c) => c.id === p.id) as CategoryView;
}
