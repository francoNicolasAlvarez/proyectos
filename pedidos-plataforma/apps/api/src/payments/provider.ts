/** Abstracción del proveedor de pagos (ADR 0003). Mercado Pago es la primera implementación. */

export type ProviderPaymentStatus = 'approved' | 'rejected' | 'pending' | 'refunded' | 'other';

export interface ProviderPayment {
  id: string;
  status: ProviderPaymentStatus;
  amountCents: number;
  currency: string;
  /** Id del pedido que enviamos al crear el cobro (external_reference). */
  externalReference: string | null;
}

export interface WebhookEvent {
  /** Id único del evento para deduplicar reenvíos. */
  eventId: string;
  type: 'payment' | 'other';
  resourceId: string;
  /** Cuenta del vendedor (el local) en el proveedor: permite resolver el tenant. */
  accountId: string;
}

export interface WebhookRequest { rawBody: string; headers: Record<string, string | undefined>; query?: Record<string, string | undefined> }

export interface PaymentProvider {
  readonly name: string;
  verifyWebhookSignature(req: WebhookRequest, secret: string): boolean;
  parseWebhook(req: WebhookRequest): WebhookEvent | null;
  /** Se consulta SIEMPRE al proveedor: nunca se confía en el contenido del webhook. */
  getPayment(accessToken: string, paymentId: string): Promise<ProviderPayment>;
  /** `idempotencyKey` evita reembolsos duplicados ante reintentos. */
  refund(accessToken: string, paymentId: string, amountCents: number, idempotencyKey: string): Promise<{ refundId: string }>;
}
