/**
 * Procesamiento de pagos: webhook seguro, vencimiento de pedidos sin pagar y reembolsos con reintentos.
 * El webhook solo avisa que "algo pasó": el estado real se consulta siempre al proveedor.
 */
import { assertPaymentTransition } from '@pasamanos/shared';
import { decryptSecret } from '../crypto-box';
import { DomainError, num, withContext, type Database, type Queryable } from '../db';
import { markPaymentApproved, transitionOrder } from '../order-service';
import type { PaymentProvider, WebhookRequest } from './provider';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PaymentDeps {
  db: Database; provider: PaymentProvider; webhookSecret: string; encryptionKey: Buffer;
  /** Rol de base de datos (solo pruebas, cuando el propietario es superusuario). */
  role?: string;
}
export type WebhookOutcome = 'ignored' | 'duplicate' | 'processed' | 'needs_review';

async function accessTokenFor(tx: Queryable, deps: PaymentDeps, tenantId: string): Promise<string> {
  const acc = (await tx.query<Row>("SELECT access_token_enc FROM tenant_payment_accounts WHERE tenant_id=$1 AND provider=$2 AND status='active'", [tenantId, deps.provider.name])).rows[0];
  if (!acc) throw new DomainError('PAYMENT_ACCOUNT_NOT_CONNECTED');
  return decryptSecret(acc.access_token_enc, deps.encryptionKey);
}

export async function handlePaymentWebhook(deps: PaymentDeps, req: WebhookRequest): Promise<{ outcome: WebhookOutcome }> {
  // 1. Autenticidad: firma verificada con el secreto del proveedor.
  if (!deps.provider.verifyWebhookSignature(req, deps.webhookSecret)) throw new DomainError('INVALID_SIGNATURE');
  const evt = deps.provider.parseWebhook(req);
  if (!evt || evt.type !== 'payment') return { outcome: 'ignored' };

  // 2. A qué local pertenece la cuenta del vendedor.
  const tenantId = await withContext(deps.db, { role: deps.role }, async (tx) =>
    (await tx.query<Row>('SELECT tenant_id FROM provider_account_directory WHERE provider=$1 AND provider_account_id=$2', [deps.provider.name, evt.accountId])).rows[0]?.tenant_id as string | undefined);
  if (!tenantId) throw new DomainError('UNKNOWN_ACCOUNT');
  const ctx = { tenantId, role: deps.role };

  // 3. Registro del evento (deduplicación). Un evento ya procesado no se repite; uno fallido se reintenta.
  const ev = await withContext(deps.db, ctx, async (tx) => {
    const ins = await tx.query<Row>(
      'INSERT INTO payment_events (tenant_id, provider, provider_event_id, payload) VALUES ($1,$2,$3,$4) ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id',
      [tenantId, deps.provider.name, evt.eventId, JSON.stringify({ raw: req.rawBody.slice(0, 20_000) })]);
    if (ins.rows[0]) return { id: ins.rows[0].id as string, processed: false };
    const ex = (await tx.query<Row>('SELECT id, processed_at FROM payment_events WHERE provider=$1 AND provider_event_id=$2', [deps.provider.name, evt.eventId])).rows[0];
    if (!ex) throw new DomainError('EVENT_CONFLICT');
    return { id: ex.id as string, processed: ex.processed_at != null };
  });
  if (ev.processed) return { outcome: 'duplicate' };

  // 4. Consulta del estado real al proveedor (fuera de la transacción: es una llamada de red).
  const token = await withContext(deps.db, ctx, (tx) => accessTokenFor(tx, deps, tenantId));
  const payment = await deps.provider.getPayment(token, evt.resourceId);

  // 5. Aplicar el resultado. Ante un error inesperado se guarda y se relanza para que el proveedor reintente.
  try {
    return await withContext(deps.db, ctx, async (tx) => {
      let outcome: WebhookOutcome = 'processed';
      let note: string | null = null;
      const review = async (why: string) => {
        outcome = 'needs_review'; note = why;
        await tx.query('INSERT INTO outbox_events (tenant_id, type, payload) VALUES ($1,$2,$3)', [tenantId, 'payment.needs_review', JSON.stringify({ providerPaymentId: payment.id, why })]);
      };
      const orderId = payment.externalReference;
      if (!orderId || !UUID.test(orderId)) await review('NO_VALID_EXTERNAL_REFERENCE');
      else if (payment.status === 'approved') {
        try {
          await markPaymentApproved(tx, { tenantId, orderId, provider: deps.provider.name, providerPaymentId: payment.id, amountCents: payment.amountCents });
        } catch (e) {
          if (e instanceof DomainError && ['AMOUNT_MISMATCH', 'ORDER_NOT_FOUND', 'PAYMENT_NOT_EXPECTED'].includes(e.code)) await review(e.code);
          else throw e;
        }
      } else if (payment.status === 'rejected') {
        // Un intento rechazado no cancela el pedido: el cliente puede reintentar con otro medio.
        const exists = await tx.query('SELECT 1 FROM orders WHERE tenant_id=$1 AND id=$2', [tenantId, orderId]);
        if (!exists.rows.length) await review('ORDER_NOT_FOUND');
        else await tx.query(
          "INSERT INTO payments (tenant_id, order_id, provider, provider_payment_id, status, amount_cents, currency) VALUES ($1,$2,$3,$4,'rejected',$5,$6) ON CONFLICT (provider, provider_payment_id) DO NOTHING",
          [tenantId, orderId, deps.provider.name, payment.id, payment.amountCents, payment.currency]);
      }
      await tx.query('UPDATE payment_events SET processed_at = now(), error = $2 WHERE id = $1', [ev.id, note]);
      return { outcome };
    });
  } catch (e) {
    await withContext(deps.db, ctx, (tx) => tx.query('UPDATE payment_events SET error = $2 WHERE id = $1', [ev.id, String((e as Error).message).slice(0, 500)]));
    throw e;
  }
}

/** Cancela los pedidos que nunca se pagaron. Un pago tardío posterior se reembolsa (markPaymentApproved). */
export async function expireUnpaidOrders(db: Database, opts: { olderThanMinutes: number; limit?: number; role?: string }): Promise<number> {
  const stale = await withContext(db, { admin: true, role: opts.role }, async (tx) =>
    (await tx.query<Row>(
      `SELECT id, tenant_id FROM orders WHERE operational_status='awaiting_payment' AND payment_status='pending'
       AND placed_at < now() - make_interval(mins => $1::int) ORDER BY placed_at LIMIT $2`, [opts.olderThanMinutes, opts.limit ?? 100])).rows);
  let n = 0;
  for (const o of stale) {
    await withContext(db, { tenantId: o.tenant_id, role: opts.role }, async (tx) => {
      await transitionOrder(tx, { tenantId: o.tenant_id, orderId: o.id, to: 'cancelled', actor: 'system', reasonCode: 'other', reasonText: 'Pago no realizado a tiempo' });
      assertPaymentTransition('prepaid', 'pending', 'expired', 'system');
      await tx.query("UPDATE orders SET payment_status='expired' WHERE tenant_id=$1 AND id=$2", [o.tenant_id, o.id]);
      await tx.query(
        `INSERT INTO order_status_history (tenant_id, order_id, axis, from_status, to_status, actor_kind) VALUES ($1,$2,'payment','pending','expired','system')`, [o.tenant_id, o.id]);
    });
    n++;
  }
  return n;
}

/** Ejecuta los reembolsos pendientes con reintentos. Cada intento usa una clave de idempotencia estable. */
export async function processPendingRefunds(deps: PaymentDeps, opts: { maxAttempts?: number; limit?: number } = {}) {
  const max = opts.maxAttempts ?? 5;
  const claimed = await withContext(deps.db, { admin: true, role: deps.role }, async (tx) =>
    (await tx.query<Row>(
      `UPDATE refunds SET attempts = attempts + 1
       WHERE id IN (SELECT id FROM refunds WHERE status='pending' AND attempts < $1 ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
       RETURNING id, tenant_id, payment_id, amount_cents, attempts`, [max, opts.limit ?? 20])).rows);

  const summary = { succeeded: 0, retry: 0, failed: 0 };
  for (const r of claimed) {
    const ctx = { tenantId: r.tenant_id as string, role: deps.role };
    try {
      const { token, providerPaymentId } = await withContext(deps.db, ctx, async (tx) => {
        const pay = (await tx.query<Row>('SELECT provider_payment_id FROM payments WHERE tenant_id=$1 AND id=$2', [r.tenant_id, r.payment_id])).rows[0] as Row;
        return { token: await accessTokenFor(tx, deps, r.tenant_id), providerPaymentId: pay.provider_payment_id as string };
      });
      const res = await deps.provider.refund(token, providerPaymentId, num(r.amount_cents), `refund-${r.id}`);
      await withContext(deps.db, ctx, async (tx) => {
        await tx.query("UPDATE refunds SET status='succeeded', provider_refund_id=$2, last_error=NULL WHERE id=$1", [r.id, res.refundId]);
        await tx.query("UPDATE payments SET status='refunded' WHERE tenant_id=$1 AND id=$2", [r.tenant_id, r.payment_id]);
        const order = (await tx.query<Row>('SELECT id, payment_status, total_cents FROM orders WHERE tenant_id=$1 AND id=(SELECT order_id FROM payments WHERE id=$2) FOR UPDATE', [r.tenant_id, r.payment_id])).rows[0];
        if (order && order.payment_status === 'refund_pending') {
          const to = num(r.amount_cents) >= num(order.total_cents) ? 'refunded' : 'partially_refunded';
          assertPaymentTransition('prepaid', 'refund_pending', to, 'provider');
          await tx.query('UPDATE orders SET payment_status=$3 WHERE tenant_id=$1 AND id=$2', [r.tenant_id, order.id, to]);
          await tx.query(
            `INSERT INTO order_status_history (tenant_id, order_id, axis, from_status, to_status, actor_kind) VALUES ($1,$2,'payment','refund_pending',$3,'provider')`, [r.tenant_id, order.id, to]);
        }
        await tx.query('INSERT INTO outbox_events (tenant_id, type, payload) VALUES ($1,$2,$3)', [r.tenant_id, 'refund.succeeded', JSON.stringify({ refundId: r.id })]);
      });
      summary.succeeded++;
    } catch (e) {
      const exhausted = num(r.attempts) >= max;
      await withContext(deps.db, ctx, async (tx) => {
        await tx.query('UPDATE refunds SET last_error=$2, status=$3 WHERE id=$1', [r.id, String((e as Error).message).slice(0, 500), exhausted ? 'failed' : 'pending']);
        // Un reembolso que agota sus intentos requiere atención humana inmediata.
        if (exhausted) await tx.query('INSERT INTO outbox_events (tenant_id, type, payload) VALUES ($1,$2,$3)', [r.tenant_id, 'refund.failed', JSON.stringify({ refundId: r.id })]);
      });
      exhausted ? summary.failed++ : summary.retry++;
    }
  }
  return summary;
}
