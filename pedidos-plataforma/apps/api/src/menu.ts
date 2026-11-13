/** Resolución de tenant y de menú vigente (sin dependencias de otros servicios). */
import type { Queryable } from './db';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function resolveTenantBySlug(tx: Queryable, slug: string): Promise<{ id: string; name: string; timezone: string } | null> {
  const t = (await tx.query<Row>("SELECT id, name, timezone FROM tenants WHERE lower(slug) = $1 AND status = 'active'", [slug.trim().toLowerCase()])).rows[0];
  return t ? { id: t.id, name: t.name, timezone: t.timezone } : null;
}

/**
 * Menú vigente: el de un evento publicado dentro de su ventana de pedidos reemplaza al habitual;
 * fuera de esa ventana rige el menú por defecto. Una sola regla para el menú público y para validar pedidos.
 */
export async function resolveActiveMenu(tx: Queryable, tenantId: string, now?: Date): Promise<{ menuId: string; eventId: string | null } | null> {
  const at = now?.toISOString() ?? null;
  const ev = (await tx.query<Row>(
    `SELECT m.id AS menu_id, e.id AS event_id FROM menus m JOIN events e ON e.tenant_id = m.tenant_id AND e.id = m.event_id
     WHERE m.tenant_id = $1 AND m.active AND m.kind = 'event' AND e.status = 'published'
       AND COALESCE($2::timestamptz, now()) >= COALESCE(e.orders_open_at, e.starts_at)
       AND COALESCE($2::timestamptz, now()) <  COALESCE(e.orders_close_at, e.ends_at)
       AND (m.valid_from IS NULL OR m.valid_from <= COALESCE($2::timestamptz, now()))
       AND (m.valid_until IS NULL OR m.valid_until > COALESCE($2::timestamptz, now()))
     ORDER BY e.starts_at DESC LIMIT 1`, [tenantId, at])).rows[0];
  if (ev) return { menuId: ev.menu_id, eventId: ev.event_id };
  const def = (await tx.query<Row>('SELECT id FROM menus WHERE tenant_id = $1 AND is_default AND active', [tenantId])).rows[0];
  return def ? { menuId: def.id, eventId: null } : null;
}

