/**
 * Control operativo rápido del local: agotar o reactivar productos, pausar categorías y pausar los pedidos.
 * Es la herramienta principal para evitar rechazos en horas pico, así que cada cambio es inmediato y queda auditado.
 */
import { DomainError, type Queryable } from './db';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const audit = (tx: Queryable, p: { tenantId: string; actorUserId: string; action: string; entity: string; entityId: string; before: unknown; after: unknown }) =>
  tx.query('INSERT INTO audit_log (tenant_id, actor_user_id, action, entity, entity_id, before, after) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [p.tenantId, p.actorUserId, p.action, p.entity, p.entityId, JSON.stringify(p.before), JSON.stringify(p.after)]);

export async function setProductAvailable(tx: Queryable, p: { tenantId: string; productId: string; available: boolean; actorUserId: string }): Promise<{ id: string; name: string; available: boolean }> {
  const cur = (await tx.query<Row>('SELECT id, name, available FROM products WHERE tenant_id = $1 AND id = $2 AND archived_at IS NULL FOR UPDATE', [p.tenantId, p.productId])).rows[0];
  if (!cur) throw new DomainError('PRODUCT_NOT_FOUND');
  if (cur.available !== p.available) {
    await tx.query('UPDATE products SET available = $3 WHERE tenant_id = $1 AND id = $2', [p.tenantId, p.productId, p.available]);
    await audit(tx, { ...p, action: 'product.availability_changed', entity: 'product', entityId: p.productId, before: { available: cur.available }, after: { available: p.available } });
  }
  return { id: cur.id, name: cur.name, available: p.available };
}

export async function setCategoryPaused(tx: Queryable, p: { tenantId: string; categoryId: string; paused: boolean; actorUserId: string }): Promise<{ id: string; name: string; paused: boolean }> {
  const cur = (await tx.query<Row>('SELECT id, name, paused FROM categories WHERE tenant_id = $1 AND id = $2 AND archived_at IS NULL FOR UPDATE', [p.tenantId, p.categoryId])).rows[0];
  if (!cur) throw new DomainError('CATEGORY_NOT_FOUND');
  if (cur.paused !== p.paused) {
    await tx.query('UPDATE categories SET paused = $3 WHERE tenant_id = $1 AND id = $2', [p.tenantId, p.categoryId, p.paused]);
    await audit(tx, { ...p, action: 'category.pause_changed', entity: 'category', entityId: p.categoryId, before: { paused: cur.paused }, after: { paused: p.paused } });
  }
  return { id: cur.id, name: cur.name, paused: p.paused };
}

/** Pausa o reanuda TODOS los pedidos del local. El mensaje (opcional) lo ven los clientes en el menú. */
export async function setOrderingPaused(tx: Queryable, p: { tenantId: string; paused: boolean; message?: string | null; actorUserId: string }): Promise<{ paused: boolean; message: string | null }> {
  const cur = (await tx.query<Row>('SELECT ordering_paused, pause_message FROM tenant_settings WHERE tenant_id = $1 FOR UPDATE', [p.tenantId])).rows[0];
  if (!cur) throw new DomainError('TENANT_NOT_CONFIGURED');
  const message = p.paused ? (p.message?.trim() || null) : null;     // al reanudar se borra el mensaje
  await tx.query('UPDATE tenant_settings SET ordering_paused = $2, pause_message = $3 WHERE tenant_id = $1', [p.tenantId, p.paused, message]);
  await audit(tx, { ...p, action: 'ordering.pause_changed', entity: 'tenant_settings', entityId: p.tenantId, before: { paused: cur.ordering_paused, message: cur.pause_message ?? null }, after: { paused: p.paused, message } });
  return { paused: p.paused, message };
}
