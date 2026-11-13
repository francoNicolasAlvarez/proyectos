/** Puntos de retiro del local (barra, punto de comida…). Siempre debe haber exactamente un punto por defecto activo. */
import { DomainError, num, type Queryable } from './db';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface PickupPointView { id: string; name: string; description: string | null; isDefault: boolean; active: boolean; sortOrder: number }
const view = (r: Row): PickupPointView => ({ id: r.id, name: r.name, description: r.description ?? null, isDefault: r.is_default, active: r.active, sortOrder: num(r.sort_order) });

export async function listPickupPoints(tx: Queryable, tenantId: string): Promise<PickupPointView[]> {
  return (await tx.query<Row>('SELECT id, name, description, is_default, active, sort_order FROM pickup_points WHERE tenant_id = $1 ORDER BY sort_order, name', [tenantId])).rows.map(view);
}

const audit = (tx: Queryable, p: { tenantId: string; actorUserId: string; action: string; id: string; before?: unknown; after?: unknown }) =>
  tx.query('INSERT INTO audit_log (tenant_id, actor_user_id, action, entity, entity_id, before, after) VALUES ($1,$2,$3,\'pickup_point\',$4,$5,$6)',
    [p.tenantId, p.actorUserId, p.action, p.id, p.before === undefined ? null : JSON.stringify(p.before), p.after === undefined ? null : JSON.stringify(p.after)]);

export async function createPickupPoint(tx: Queryable, p: { tenantId: string; actorUserId: string; name: string; description?: string | null; makeDefault?: boolean }): Promise<PickupPointView> {
  const name = p.name.trim();
  if (!name) throw new DomainError('NAME_REQUIRED');
  if ((await tx.query('SELECT 1 FROM pickup_points WHERE tenant_id = $1 AND active AND lower(name) = lower($2)', [p.tenantId, name])).rows.length) throw new DomainError('POINT_NAME_TAKEN');
  const hasDefault = (await tx.query('SELECT 1 FROM pickup_points WHERE tenant_id = $1 AND active AND is_default', [p.tenantId])).rows.length > 0;
  const isDefault = p.makeDefault === true || !hasDefault;               // el primero siempre es el predeterminado
  if (isDefault && hasDefault) await tx.query('UPDATE pickup_points SET is_default = false WHERE tenant_id = $1 AND is_default', [p.tenantId]);
  const sort = num((await tx.query<Row>('SELECT coalesce(max(sort_order), 0) + 1 AS n FROM pickup_points WHERE tenant_id = $1', [p.tenantId])).rows[0]?.n);
  const r = (await tx.query<Row>('INSERT INTO pickup_points (tenant_id, name, description, is_default, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, description, is_default, active, sort_order',
    [p.tenantId, name, p.description?.trim() || null, isDefault, sort])).rows[0] as Row;
  await audit(tx, { tenantId: p.tenantId, actorUserId: p.actorUserId, action: 'pickup_point.created', id: r.id, after: { name, isDefault } });
  return view(r);
}

export async function updatePickupPoint(tx: Queryable, p: { tenantId: string; actorUserId: string; id: string; name?: string; description?: string | null; active?: boolean; isDefault?: boolean }): Promise<PickupPointView> {
  const cur = (await tx.query<Row>('SELECT id, name, description, is_default, active, sort_order FROM pickup_points WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [p.tenantId, p.id])).rows[0];
  if (!cur) throw new DomainError('PICKUP_POINT_NOT_FOUND');
  const name = p.name === undefined ? cur.name : p.name.trim();
  if (!name) throw new DomainError('NAME_REQUIRED');
  const active = p.active ?? cur.active;
  let isDefault = p.isDefault ?? cur.is_default;

  if (isDefault === false && cur.is_default && p.isDefault === false) throw new DomainError('DEFAULT_POINT_REQUIRED');     // para cambiar el predeterminado, se marca otro
  if (!active && cur.is_default) throw new DomainError('DEFAULT_POINT_CANNOT_BE_DEACTIVATED');
  if (!active) isDefault = false;
  if (active && (name.toLowerCase() !== String(cur.name).toLowerCase() || !cur.active)) {
    const dup = await tx.query('SELECT 1 FROM pickup_points WHERE tenant_id = $1 AND active AND lower(name) = lower($2) AND id <> $3', [p.tenantId, name, p.id]);
    if (dup.rows.length) throw new DomainError('POINT_NAME_TAKEN');
  }
  if (isDefault && !cur.is_default) await tx.query('UPDATE pickup_points SET is_default = false WHERE tenant_id = $1 AND is_default', [p.tenantId]);
  const description = p.description === undefined ? cur.description : (p.description?.trim() || null);
  const r = (await tx.query<Row>('UPDATE pickup_points SET name = $3, description = $4, active = $5, is_default = $6 WHERE tenant_id = $1 AND id = $2 RETURNING id, name, description, is_default, active, sort_order',
    [p.tenantId, p.id, name, description, active, isDefault])).rows[0] as Row;
  await audit(tx, { tenantId: p.tenantId, actorUserId: p.actorUserId, action: 'pickup_point.updated', id: p.id,
    before: { name: cur.name, active: cur.active, isDefault: cur.is_default }, after: { name, active, isDefault } });
  return view(r);
}
