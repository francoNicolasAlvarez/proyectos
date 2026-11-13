/**
 * Adaptador de Mercado Pago.
 * ATENCIÓN: escrito a partir de la documentación pública y probado solo con respuestas simuladas.
 * Antes de producción hay que verificarlo contra el sandbox real de Mercado Pago (formato de la firma,
 * campos de la respuesta y reembolsos) y revisar las condiciones vigentes del esquema marketplace.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PaymentProvider, ProviderPayment, ProviderPaymentStatus, WebhookEvent, WebhookRequest } from './provider';

const API = 'https://api.mercadopago.com';

function parseSignature(header: string | undefined): { ts?: string; v1?: string } {
  const out: { ts?: string; v1?: string } = {};
  for (const part of (header ?? '').split(',')) {
    const [k, v] = part.split('=').map((x) => x.trim());
    if (k === 'ts') out.ts = v;
    if (k === 'v1') out.v1 = v;
  }
  return out;
}

const header = (req: WebhookRequest, name: string) =>
  Object.entries(req.headers).find(([k]) => k.toLowerCase() === name)?.[1];

function dataId(req: WebhookRequest): string | undefined {
  const fromQuery = req.query?.['data.id'];
  if (fromQuery) return fromQuery;
  try { const b = JSON.parse(req.rawBody); return b?.data?.id != null ? String(b.data.id) : undefined; } catch { return undefined; }
}

export const mpStatus = (s: string | undefined): ProviderPaymentStatus =>
  s === 'approved' ? 'approved' : s === 'rejected' || s === 'cancelled' ? 'rejected'
    : s === 'pending' || s === 'in_process' || s === 'authorized' ? 'pending' : s === 'refunded' ? 'refunded' : 'other';

export interface MercadoPagoOptions { fetchImpl?: typeof fetch; toleranceMs?: number; now?: () => number }

export class MercadoPagoProvider implements PaymentProvider {
  readonly name = 'mercadopago';
  private readonly f: typeof fetch;
  constructor(private readonly opts: MercadoPagoOptions = {}) { this.f = opts.fetchImpl ?? fetch; }

  /** Firma `x-signature: ts=...,v1=...` sobre el manifiesto `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`. */
  verifyWebhookSignature(req: WebhookRequest, secret: string): boolean {
    const { ts, v1 } = parseSignature(header(req, 'x-signature'));
    const id = dataId(req);
    const requestId = header(req, 'x-request-id');
    if (!ts || !v1 || !id || !requestId || !secret) return false;
    const tolerance = this.opts.toleranceMs ?? 5 * 60_000;    // anti-repetición: rechaza firmas viejas
    const now = (this.opts.now ?? Date.now)();
    const tsMs = Number(ts) < 1e12 ? Number(ts) * 1000 : Number(ts);
    if (!Number.isFinite(tsMs) || Math.abs(now - tsMs) > tolerance) return false;
    const expected = createHmac('sha256', secret).update(`id:${id.toLowerCase()};request-id:${requestId};ts:${ts};`).digest('hex');
    const a = Buffer.from(expected), b = Buffer.from(v1);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(req: WebhookRequest): WebhookEvent | null {
    try {
      const b = JSON.parse(req.rawBody);
      const type = b.type === 'payment' || String(b.action ?? '').startsWith('payment.') ? 'payment' : 'other';
      if (b?.data?.id == null || b.user_id == null) return null;
      // El id del evento combina notificación y acción: el mismo pago puede notificarse varias veces con acciones distintas.
      return { eventId: String(b.id ?? `${b.data.id}:${b.action ?? ''}`), type, resourceId: String(b.data.id), accountId: String(b.user_id) };
    } catch { return null; }
  }

  async getPayment(accessToken: string, paymentId: string): Promise<ProviderPayment> {
    const r = await this.f(`${API}/v1/payments/${encodeURIComponent(paymentId)}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) throw new Error(`mercadopago getPayment ${r.status}`);
    const p = await r.json() as Record<string, unknown>;
    return {
      id: String(p.id), status: mpStatus(p.status as string | undefined),
      amountCents: Math.round(Number(p.transaction_amount) * 100), currency: String(p.currency_id ?? 'ARS'),
      externalReference: p.external_reference != null ? String(p.external_reference) : null,
    };
  }

  async refund(accessToken: string, paymentId: string, amountCents: number, idempotencyKey: string) {
    const r = await this.f(`${API}/v1/payments/${encodeURIComponent(paymentId)}/refunds`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'X-Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ amount: amountCents / 100 }),
    });
    if (!r.ok) throw new Error(`mercadopago refund ${r.status}`);
    const b = await r.json() as Record<string, unknown>;
    return { refundId: String(b.id) };
  }
}
