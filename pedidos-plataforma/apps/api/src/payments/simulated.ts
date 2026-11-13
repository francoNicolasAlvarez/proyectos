/**
 * Proveedor de pago SIMULADO, solo para desarrollo: permite recorrer el flujo completo (pedir, pagar, aceptar, preparar,
 * retirar, reembolsar) sin Mercado Pago. Implementa la misma interfaz y los pagos pasan por el MISMO procesamiento de
 * webhook que los reales (firma, deduplicación, consulta al proveedor, verificación de importe).
 * Nunca debe habilitarse en producción: el servidor se niega a arrancar así.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { CheckoutInput, PaymentProvider, ProviderPayment, WebhookRequest } from './provider';

export class SimulatedProvider implements PaymentProvider {
  readonly name = 'simulated';
  private readonly payments = new Map<string, ProviderPayment>();
  private readonly checkouts = new Map<string, CheckoutInput>();

  constructor(private readonly publicApiUrl: string) {}

  private sign(body: string, secret: string) { return createHmac('sha256', secret).update(body).digest('hex'); }

  verifyWebhookSignature(req: WebhookRequest, secret: string): boolean {
    const got = req.headers['x-simulated-signature'];
    if (!got || !secret) return false;
    const a = Buffer.from(this.sign(req.rawBody, secret)); const b = Buffer.from(got);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(req: WebhookRequest) {
    try {
      const b = JSON.parse(req.rawBody);
      if (b?.data?.id == null || b.user_id == null) return null;
      return { eventId: String(b.id), type: (b.type === 'payment' ? 'payment' : 'other') as 'payment' | 'other', resourceId: String(b.data.id), accountId: String(b.user_id) };
    } catch { return null; }
  }

  async createCheckout(_token: string, input: CheckoutInput) {
    this.checkouts.set(input.orderId, input);
    return { checkoutUrl: `${this.publicApiUrl}/dev/pay/${input.orderId}`, providerReference: `sim-${input.orderId}` };
  }

  async getPayment(_token: string, paymentId: string): Promise<ProviderPayment> {
    const p = this.payments.get(paymentId);
    if (!p) throw new Error('pago simulado inexistente');
    return p;
  }

  async refund(_token: string, paymentId: string, _amountCents: number, key: string) {
    const p = this.payments.get(paymentId);
    if (p) this.payments.set(paymentId, { ...p, status: 'refunded' });
    return { refundId: `sim-refund-${key}` };
  }

  /** Lo que el cliente vio al crear el cobro (para mostrar el importe en la página de pago simulada). */
  checkoutFor(orderId: string): CheckoutInput | undefined { return this.checkouts.get(orderId); }

  /** Registra un pago como lo haría el proveedor y devuelve el webhook firmado que lo anuncia. */
  announce(p: { orderId: string; amountCents: number; status: 'approved' | 'rejected'; accountId: string; secret: string }) {
    const id = `sim-pay-${randomUUID()}`;
    this.payments.set(id, { id, status: p.status, amountCents: p.amountCents, currency: 'ARS', externalReference: p.orderId });
    const rawBody = JSON.stringify({ id: `sim-ev-${randomUUID()}`, type: 'payment', action: 'payment.updated', user_id: p.accountId, data: { id } });
    return { rawBody, headers: { 'x-simulated-signature': this.sign(rawBody, p.secret) } as Record<string, string> };
  }
}
