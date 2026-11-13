/**
 * Gestión de reembolsos por el personal: ver los pendientes y fallidos, y reintentar a mano los que agotaron sus intentos.
 * Un reembolso fallido es dinero del cliente sin devolver: tiene que ser visible y accionable.
 */
import { DomainError, num, type Queryable } from '../db';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type RefundStatus = 'pending' | 'succeeded' | 'failed';
export interface RefundView {
  id: string; status: RefundStatus; amountCents: number; attempts: number; lastError: string | null; reason: string | null;
  createdAt: string; orderId: string; orderNumber: number;
}

export async function listRefunds(tx: Queryable, tenantId: string, opts: { status?: RefundStatus } = {}): Promise<RefundView[]> {
  const r = await tx.query<Row>(
    `SELECT r.id, r.status, r.amount_cents, r.attempts, r.last_error, r.reason, r.created_at, o.id AS order_id, o.order_number
     FROM refunds r JOIN payments p ON p.tenant_id = r.tenant_id AND p.id = r.payment_id JOIN orders o ON o.tenant_id = p.tenant_id AND o.id = p.order_id
     WHERE r.tenant_id = $1 AND ($2::text IS NULL OR r.status = $2) ORDER BY r.created_at DESC LIMIT 200`, [tenantId, opts.status ?? null]);
  return r.rows.map((x) => ({
    id: x.id, status: x.status, amountCents: num(x.amount_cents), attempts: num(x.attempts), lastError: x.last_error ?? null, reason: x.reason ?? null,
    createdAt: new Date(x.created_at).toISOString(), orderId: x.order_id, orderNumber: num(x.order_number),
  }));
}

/** Devuelve un reembolso fallido a "pendiente" con los intentos en cero: el trabajador lo vuelve a intentar. Queda auditado. */
export async function retryRefund(tx: Queryable, p: { tenantId: string; refundId: string; actorUserId: string }): Promise<void> {
  const r = (await tx.query<Row>('SELECT id, status, attempts, last_error FROM refunds WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [p.tenantId, p.refundId])).rows[0];
  if (!r) throw new DomainError('REFUND_NOT_FOUND');
  if (r.status !== 'failed') throw new DomainError('REFUND_NOT_RETRYABLE');
  await tx.query("UPDATE refunds SET status = 'pending', attempts = 0 WHERE tenant_id = $1 AND id = $2", [p.tenantId, p.refundId]);
  await tx.query(
    "INSERT INTO audit_log (tenant_id, actor_user_id, action, entity, entity_id, before, after) VALUES ($1,$2,'refund.retry_requested','refund',$3,$4,$5)",
    [p.tenantId, p.actorUserId, p.refundId, JSON.stringify({ status: 'failed', attempts: num(r.attempts), lastError: r.last_error ?? null }), JSON.stringify({ status: 'pending', attempts: 0 })]);
}
