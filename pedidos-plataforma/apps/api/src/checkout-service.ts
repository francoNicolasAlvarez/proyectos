/** Prepara el cobro de un pedido: verifica que se pueda pagar y arma los datos para el proveedor. */
import { decryptSecret } from './crypto-box';
import { DomainError, num, type Queryable } from './db';
import type { CheckoutInput } from './payments/provider';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface CheckoutUrls { notificationUrl: string; backUrls: CheckoutInput['backUrls'] }

/**
 * Debe ejecutarse con el contexto del local y del cliente. Solo el dueño del pedido puede iniciar su cobro,
 * y solo mientras esté sin pagar y dentro de la ventana de pago del local.
 */
export async function buildCheckout(tx: Queryable, p: { tenantId: string; userId: string; orderId: string; provider: string; encryptionKey: Buffer; urls: CheckoutUrls; now?: Date }):
  Promise<{ input: CheckoutInput; accessToken: string }> {
  const o = (await tx.query<Row>('SELECT * FROM orders WHERE tenant_id=$1 AND id=$2 AND user_id=$3', [p.tenantId, p.orderId, p.userId])).rows[0];
  if (!o) throw new DomainError('ORDER_NOT_FOUND');
  if (o.operational_status !== 'awaiting_payment' || o.payment_status !== 'pending') throw new DomainError('ORDER_NOT_PAYABLE');

  const windowMin = num((await tx.query<Row>('SELECT payment_window_minutes FROM tenant_settings WHERE tenant_id=$1', [p.tenantId])).rows[0]?.payment_window_minutes ?? 10);
  const expiresAt = new Date(new Date(o.placed_at).getTime() + windowMin * 60_000);
  if ((p.now ?? new Date()) >= expiresAt) throw new DomainError('PAYMENT_WINDOW_EXPIRED');

  const acc = (await tx.query<Row>("SELECT access_token_enc FROM tenant_payment_accounts WHERE tenant_id=$1 AND provider=$2 AND status='active'", [p.tenantId, p.provider])).rows[0];
  if (!acc) throw new DomainError('PAYMENT_ACCOUNT_NOT_CONNECTED');

  const items = (await tx.query<Row>('SELECT name_snapshot, quantity, unit_price_cents FROM order_items WHERE tenant_id=$1 AND order_id=$2 ORDER BY created_at', [p.tenantId, p.orderId])).rows;
  return {
    accessToken: decryptSecret(acc.access_token_enc, p.encryptionKey),
    input: {
      orderId: p.orderId, orderNumber: num(o.order_number), totalCents: num(o.total_cents), currency: String(o.currency).trim(), expiresAt,
      items: items.map((i) => ({ title: i.name_snapshot as string, quantity: num(i.quantity), unitPriceCents: num(i.unit_price_cents) })),
      notificationUrl: p.urls.notificationUrl, backUrls: p.urls.backUrls,
    },
  };
}
