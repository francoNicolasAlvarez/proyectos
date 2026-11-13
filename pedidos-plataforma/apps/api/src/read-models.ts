/** Consultas de lectura para las pantallas: menú público, cola del local y seguimiento del cliente. */
import { DomainError, num, type Queryable } from './db';
import { resolveActiveMenu } from './menu';
import { getPickupCredentials } from './order-service';

export { resolveActiveMenu, resolveTenantBySlug } from './menu';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface PublicMenu {
  menuId: string; eventId: string | null; paused: boolean; pauseMessage: string | null;
  categories: { id: string; name: string; paused: boolean; products: PublicProduct[] }[];
}
export interface PublicProduct {
  id: string; name: string; description: string | null; ingredients: string | null; imageUrl: string | null;
  priceCents: number; prepMinutes: number; available: boolean;
  groups: { id: string; name: string; min: number; max: number; options: { id: string; name: string; priceDeltaCents: number; available: boolean }[] }[];
}

export async function getPublicMenu(tx: Queryable, tenantId: string, now?: Date): Promise<PublicMenu> {
  const active = await resolveActiveMenu(tx, tenantId, now);
  if (!active) throw new DomainError('NO_ACTIVE_MENU');
  const settings = (await tx.query<Row>('SELECT ordering_paused, pause_message FROM tenant_settings WHERE tenant_id = $1', [tenantId])).rows[0];
  const cats = (await tx.query<Row>('SELECT id, name, paused FROM categories WHERE tenant_id=$1 AND menu_id=$2 AND archived_at IS NULL ORDER BY sort_order, name', [tenantId, active.menuId])).rows;
  const prods = (await tx.query<Row>(
    `SELECT p.* FROM products p JOIN categories c ON c.tenant_id = p.tenant_id AND c.id = p.category_id
     WHERE p.tenant_id=$1 AND c.menu_id=$2 AND p.archived_at IS NULL ORDER BY p.sort_order, p.name`, [tenantId, active.menuId])).rows;
  const opts = (await tx.query<Row>(
    `SELECT g.id AS gid, g.product_id, g.name AS gname, g.min_select, g.max_select, g.sort_order AS gsort,
            o.id AS oid, o.name AS oname, o.price_delta_cents, o.available, o.sort_order AS osort
     FROM option_groups g LEFT JOIN options o ON o.tenant_id = g.tenant_id AND o.group_id = g.id
     WHERE g.tenant_id=$1 AND g.product_id IN (SELECT p.id FROM products p JOIN categories c ON c.tenant_id=p.tenant_id AND c.id=p.category_id WHERE p.tenant_id=$1 AND c.menu_id=$2)
     ORDER BY g.sort_order, g.name, o.sort_order, o.name`, [tenantId, active.menuId])).rows;

  const groupsOf = (pid: string) => {
    const map = new Map<string, PublicProduct['groups'][number]>();
    for (const r of opts.filter((x) => x.product_id === pid)) {
      let g = map.get(r.gid);
      if (!g) { g = { id: r.gid, name: r.gname, min: num(r.min_select), max: num(r.max_select), options: [] }; map.set(r.gid, g); }
      if (r.oid) g.options.push({ id: r.oid, name: r.oname, priceDeltaCents: num(r.price_delta_cents), available: r.available });
    }
    return [...map.values()];
  };
  return {
    menuId: active.menuId, eventId: active.eventId, paused: !!settings?.ordering_paused, pauseMessage: settings?.pause_message ?? null,
    categories: cats.map((c) => ({
      id: c.id, name: c.name, paused: c.paused,
      products: prods.filter((p) => p.category_id === c.id).map((p) => ({
        id: p.id, name: p.name, description: p.description, ingredients: p.ingredients, imageUrl: p.image_url,
        priceCents: num(p.base_price_cents), prepMinutes: num(p.prep_minutes),
        available: p.available && !c.paused, groups: groupsOf(p.id),
      })),
    })),
  };
}

/** Cola del local: pedidos ya pagados y todavía no cerrados, del más antiguo al más nuevo. */
export async function getVenueQueue(tx: Queryable, tenantId: string) {
  const orders = (await tx.query<Row>(
    `SELECT o.id, o.order_number, o.operational_status, o.payment_status, o.total_cents, o.placed_at, o.estimated_ready_at,
            o.origin_location_name_snapshot AS origin, o.accepted_at
     FROM orders o WHERE o.tenant_id = $1 AND o.operational_status IN ('pending_acceptance','accepted','preparing','ready')
     ORDER BY o.placed_at, o.order_number`, [tenantId])).rows;
  if (!orders.length) return [];
  const ids = orders.map((o) => o.id);
  const ph = ids.map((_, i) => `$${i + 2}`).join(',');
  const parts = (await tx.query<Row>(
    `SELECT p.id, p.order_id, p.status, p.pickup_point_id, pp.name AS pickup_point_name FROM order_parts p
     LEFT JOIN pickup_points pp ON pp.tenant_id = p.tenant_id AND pp.id = p.pickup_point_id
     WHERE p.tenant_id=$1 AND p.order_id IN (${ph}) ORDER BY p.created_at`, [tenantId, ...ids])).rows;
  const items = (await tx.query<Row>(
    `SELECT i.id, i.order_part_id, i.name_snapshot, i.quantity,
            coalesce((SELECT string_agg(s.group_name_snapshot || ': ' || s.name_snapshot, ' · ' ORDER BY s.created_at) FROM order_item_selections s WHERE s.order_item_id = i.id), '') AS detail
     FROM order_items i WHERE i.tenant_id=$1 AND i.order_id IN (${ph}) ORDER BY i.created_at`, [tenantId, ...ids])).rows;
  return orders.map((o) => ({
    id: o.id as string, number: num(o.order_number), status: o.operational_status as string, paymentStatus: o.payment_status as string,
    totalCents: num(o.total_cents), placedAt: o.placed_at as string, origin: (o.origin ?? null) as string | null,
    parts: parts.filter((p) => p.order_id === o.id).map((p) => ({
      id: p.id as string, status: p.status as string, pickupPoint: (p.pickup_point_name ?? null) as string | null,
      items: items.filter((i) => i.order_part_id === p.id).map((i) => ({ name: i.name_snapshot as string, quantity: num(i.quantity), detail: i.detail as string })),
    })),
  }));
}

/** Seguimiento del cliente: estados, punto de retiro y, cuando está listo, el QR y el código de cada parte. */
export async function getCustomerOrder(tx: Queryable, p: { orderId: string; userId: string; secret: string }) {
  // La propiedad se verifica explícitamente: con contexto de local, RLS deja ver todos los pedidos del local.
  const o = (await tx.query<Row>('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [p.orderId, p.userId])).rows[0];
  if (!o) return null;
  const parts = (await tx.query<Row>(
    `SELECT p.id, p.status, pp.name AS point FROM order_parts p LEFT JOIN pickup_points pp ON pp.tenant_id = p.tenant_id AND pp.id = p.pickup_point_id
     WHERE p.order_id = $1 ORDER BY p.created_at`, [p.orderId])).rows;
  const out = [];
  for (const part of parts) {
    const creds = part.status === 'ready' ? await getPickupCredentials(tx, { tenantId: o.tenant_id, partId: part.id, secret: p.secret }) : null;
    out.push({ id: part.id as string, status: part.status as string, pickupPoint: (part.point ?? null) as string | null, pickup: creds });
  }
  return {
    id: o.id as string, number: num(o.order_number), status: o.operational_status as string, paymentStatus: o.payment_status as string,
    totalCents: num(o.total_cents), estimatedReadyAt: (o.estimated_ready_at ?? null) as string | null,
    cancelReason: (o.cancel_reason_code ?? null) as string | null, originName: (o.origin_location_name_snapshot ?? null) as string | null, parts: out,
  };
}
