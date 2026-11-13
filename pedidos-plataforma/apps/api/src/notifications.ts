/**
 * Consumidor del outbox: convierte los hitos del pedido en notificaciones dentro de la app y las difunde en tiempo real.
 * Entrega "al menos una vez": las notificaciones quedan guardadas, y si el aviso en vivo se pierde, el cliente las lee al reconectar.
 */
import { CANCELLATION_REASONS } from '@pasamanos/shared';
import { num, withContext, type Database, type Queryable } from './db';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface Realtime { publish(channel: string, message: Record<string, unknown>): void | Promise<void> }

interface Note { type: string; title: string; body: string }

/** Textos de las notificaciones al cliente (sección 7 del análisis funcional). */
export function notesFor(type: string, ctx: { number: number; etaMinutes?: number | null; point?: string | null; reason?: string | null }): Note[] {
  const n = `#${String(ctx.number).padStart(3, '0')}`;
  switch (type) {
    case 'order.pending_acceptance':
      return [
        { type: 'payment_approved', title: 'Pago aprobado', body: `Recibimos tu pago del pedido ${n}.` },
        { type: 'order_received', title: 'Pedido enviado al local', body: `Tu pedido ${n} está esperando que el local lo acepte.` },
      ];
    case 'order.accepted':
      return [{ type: 'order_accepted', title: 'Pedido aceptado', body: `El local aceptó tu pedido ${n}${ctx.etaMinutes ? `. Tiempo estimado: ${ctx.etaMinutes} min` : ''}.` }];
    case 'order.preparing':
      return [{ type: 'order_preparing', title: 'En preparación', body: `Estamos preparando tu pedido ${n}.` }];
    case 'part.ready':
      return [{ type: 'order_ready', title: 'Listo para retirar', body: `Tu pedido ${n} está listo. Retiralo ${ctx.point ? `en ${ctx.point}` : 'en la barra'}.` }];
    case 'order.delivered':
      return [{ type: 'order_delivered', title: 'Entrega confirmada', body: `Entregamos tu pedido ${n}. ¡Que lo disfrutes!` }];
    case 'order.rejected':
      return [{ type: 'order_rejected', title: 'Pedido rechazado', body: `El local no pudo preparar tu pedido ${n}${ctx.reason ? `: ${ctx.reason}` : ''}.` }];
    case 'order.cancelled':
      return [{ type: 'order_cancelled', title: 'Pedido cancelado', body: `Se canceló tu pedido ${n}${ctx.reason ? `: ${ctx.reason}` : ''}.` }];
    case 'refund.requested':
      return [{ type: 'refund_started', title: 'Reembolso iniciado', body: `Iniciamos el reembolso del pedido ${n}.` }];
    case 'refund.succeeded':
      return [{ type: 'refund_completed', title: 'Reembolso realizado', body: `Reembolsamos el pago del pedido ${n}.` }];
    default:
      return [];
  }
}

/** Eventos que cambian la cola del local y deben refrescar su panel. */
const VENUE_EVENTS = new Set(['order.pending_acceptance', 'order.accepted', 'order.preparing', 'order.ready', 'order.delivered', 'order.rejected', 'order.cancelled', 'part.ready', 'refund.failed', 'payment.needs_review']);

async function orderContext(tx: Queryable, orderId: string): Promise<Row | undefined> {
  return (await tx.query<Row>(
    `SELECT o.id, o.user_id, o.order_number, o.estimated_ready_at, o.cancel_reason_code, o.cancel_reason_text,
            greatest(1, round(extract(epoch FROM (o.estimated_ready_at - now())) / 60))::int AS eta_min
     FROM orders o WHERE o.id = $1`, [orderId])).rows[0];
}

export async function dispatchOutbox(db: Database, rt: Realtime | null, opts: { limit?: number; role?: string } = {}): Promise<{ processed: number; notifications: number }> {
  const live: { channel: string; message: Record<string, unknown> }[] = [];
  let notifications = 0;

  const events = await withContext(db, { admin: true, role: opts.role }, async (tx) => {
    const batch = (await tx.query<Row>(
      'SELECT id, tenant_id, type, payload FROM outbox_events WHERE published_at IS NULL ORDER BY seq LIMIT $1 FOR UPDATE SKIP LOCKED', [opts.limit ?? 100])).rows;
    for (const ev of batch) {
      const payload = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
      const orderId: string | undefined = payload?.orderId ?? undefined;
      const o = orderId ? await orderContext(tx, orderId) : undefined;

      if (o) {
        let point: string | null = null;
        if (ev.type === 'part.ready' && payload.pickupPointId) {
          point = (await tx.query<Row>('SELECT name FROM pickup_points WHERE tenant_id=$1 AND id=$2', [ev.tenant_id, payload.pickupPointId])).rows[0]?.name ?? null;
        }
        const code = payload.reasonCode ?? o.cancel_reason_code;
        const reason = (code && (CANCELLATION_REASONS as Record<string, string>)[code]) || o.cancel_reason_text || null;
        for (const note of notesFor(ev.type, { number: num(o.order_number), etaMinutes: o.eta_min != null ? num(o.eta_min) : null, point, reason })) {
          await tx.query('INSERT INTO notifications (tenant_id, user_id, type, payload) VALUES ($1,$2,$3,$4)',
            [ev.tenant_id, o.user_id, note.type, JSON.stringify({ orderId, number: num(o.order_number), title: note.title, body: note.body })]);
          notifications++;
          live.push({ channel: `user:${o.user_id}`, message: { type: note.type, orderId, title: note.title, body: note.body } });
        }
      }
      if (VENUE_EVENTS.has(ev.type)) live.push({ channel: `tenant:${ev.tenant_id}`, message: { type: 'queue_changed', event: ev.type, orderId: orderId ?? null } });
      // Un reembolso fallido es dinero del cliente sin devolver: el panel debe mostrar una alerta, no solo refrescar la cola.
      if (ev.type === 'refund.failed') live.push({ channel: `tenant:${ev.tenant_id}`, message: { type: 'refund_failed', refundId: payload?.refundId ?? null } });
    }
    if (batch.length) {
      await tx.query(`UPDATE outbox_events SET published_at = now() WHERE id IN (${batch.map((_, i) => `$${i + 1}`).join(',')})`, batch.map((b) => b.id));
    }
    return batch.length;
  });

  // Difusión DESPUÉS de confirmar la transacción: nunca se anuncia algo que podría revertirse.
  if (rt) for (const l of live) { try { await rt.publish(l.channel, l.message); } catch { /* el cliente se resincroniza al reconectar */ } }
  return { processed: events, notifications };
}

export async function listNotifications(tx: Queryable, userId: string, opts: { unreadOnly?: boolean; limit?: number } = {}) {
  const r = await tx.query<Row>(
    `SELECT id, type, payload, read_at, created_at FROM notifications WHERE user_id = $1 ${opts.unreadOnly ? 'AND read_at IS NULL' : ''}
     ORDER BY seq DESC LIMIT $2`, [userId, opts.limit ?? 50]);
  return r.rows.map((n) => ({ id: n.id as string, type: n.type as string, payload: n.payload as Record<string, unknown>, read: n.read_at != null, createdAt: n.created_at as string }));
}

export async function markNotificationsRead(tx: Queryable, userId: string, ids?: string[]): Promise<number> {
  if (ids && ids.length === 0) return 0;
  const r = ids
    ? await tx.query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND id IN (${ids.map((_, i) => `$${i + 2}`).join(',')})`, [userId, ...ids])
    : await tx.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [userId]);
  return r.affectedRows ?? 0;
}
