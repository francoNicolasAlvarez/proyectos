/**
 * Promociones simples sobre el subtotal de un pedido (lógica pura, en centavos enteros).
 * Una promoción por pedido (no se acumulan): se elige la que más descuenta.
 * El descuento nunca supera el subtotal y siempre es un entero.
 */

export type PromotionKind = 'percent' | 'fixed';

export interface Promotion {
  code: string;
  kind: PromotionKind;
  /** percent: 1 a 100. fixed: centavos. */
  value: number;
  minSubtotalCents?: number;
  /** Tope del descuento en centavos (útil para porcentajes). */
  maxDiscountCents?: number;
  startsAt?: Date | null;
  endsAt?: Date | null;
  /** Usos máximos en total y por persona. */
  maxUses?: number | null;
  maxUsesPerUser?: number | null;
  active: boolean;
}

export interface PromotionUsage { totalUses: number; userUses: number }

export type PromotionResult =
  | { ok: true; discountCents: number; totalCents: number; code: string }
  | { ok: false; reason: 'INACTIVE' | 'NOT_STARTED' | 'EXPIRED' | 'MIN_SUBTOTAL' | 'EXHAUSTED' | 'USER_LIMIT' | 'INVALID' };

export function applyPromotion(promo: Promotion, subtotalCents: number, now: Date, usage: PromotionUsage = { totalUses: 0, userUses: 0 }): PromotionResult {
  if (!Number.isInteger(subtotalCents) || subtotalCents < 0) return { ok: false, reason: 'INVALID' };
  if (!Number.isFinite(promo.value) || promo.value <= 0 || (promo.kind === 'percent' && promo.value > 100)) return { ok: false, reason: 'INVALID' };
  if (!promo.active) return { ok: false, reason: 'INACTIVE' };
  if (promo.startsAt && now < promo.startsAt) return { ok: false, reason: 'NOT_STARTED' };
  if (promo.endsAt && now >= promo.endsAt) return { ok: false, reason: 'EXPIRED' };
  if (promo.minSubtotalCents != null && subtotalCents < promo.minSubtotalCents) return { ok: false, reason: 'MIN_SUBTOTAL' };
  if (promo.maxUses != null && usage.totalUses >= promo.maxUses) return { ok: false, reason: 'EXHAUSTED' };
  if (promo.maxUsesPerUser != null && usage.userUses >= promo.maxUsesPerUser) return { ok: false, reason: 'USER_LIMIT' };

  let discount = promo.kind === 'percent' ? Math.floor((subtotalCents * promo.value) / 100) : Math.floor(promo.value);
  if (promo.maxDiscountCents != null) discount = Math.min(discount, promo.maxDiscountCents);
  discount = Math.min(discount, subtotalCents);
  return { ok: true, discountCents: discount, totalCents: subtotalCents - discount, code: promo.code };
}

/** Elige la promoción aplicable que más descuenta (empate: la de código menor, para ser determinista). */
export function bestPromotion(promos: readonly Promotion[], subtotalCents: number, now: Date, usageOf: (code: string) => PromotionUsage = () => ({ totalUses: 0, userUses: 0 })): PromotionResult | null {
  let best: Extract<PromotionResult, { ok: true }> | null = null;
  for (const p of promos) {
    const r = applyPromotion(p, subtotalCents, now, usageOf(p.code));
    if (!r.ok) continue;
    if (!best || r.discountCents > best.discountCents || (r.discountCents === best.discountCents && r.code < best.code)) best = r;
  }
  return best;
}
