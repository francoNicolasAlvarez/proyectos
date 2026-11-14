import { describe, expect, it } from 'vitest';
import { applyPromotion, bestPromotion, type Promotion } from '../src';

const NOW = new Date('2026-05-10T20:00:00Z');
const promo = (extra: Partial<Promotion> = {}): Promotion => ({ code: 'P10', kind: 'percent', value: 10, active: true, ...extra });

describe('cálculo del descuento', () => {
  it('porcentaje: 10% de $18.000 = $1.800', () => {
    expect(applyPromotion(promo(), 1_800_000, NOW)).toEqual({ ok: true, discountCents: 180_000, totalCents: 1_620_000, code: 'P10' });
  });
  it('el porcentaje redondea hacia abajo (nunca regala un centavo de más)', () => {
    expect(applyPromotion(promo({ value: 15 }), 999, NOW)).toMatchObject({ discountCents: 149, totalCents: 850 });
  });
  it('monto fijo y tope de descuento', () => {
    expect(applyPromotion(promo({ kind: 'fixed', value: 200_000 }), 1_000_000, NOW)).toMatchObject({ discountCents: 200_000 });
    expect(applyPromotion(promo({ value: 50, maxDiscountCents: 300_000 }), 2_000_000, NOW)).toMatchObject({ discountCents: 300_000 });
  });
  it('el descuento nunca supera el subtotal (el total no es negativo)', () => {
    expect(applyPromotion(promo({ kind: 'fixed', value: 500_000 }), 100_000, NOW)).toMatchObject({ discountCents: 100_000, totalCents: 0 });
    expect(applyPromotion(promo({ value: 100 }), 12_345, NOW)).toMatchObject({ totalCents: 0 });
  });
  it('subtotal cero: descuento cero', () => {
    expect(applyPromotion(promo(), 0, NOW)).toMatchObject({ ok: true, discountCents: 0, totalCents: 0 });
  });
});

describe('cuándo NO aplica', () => {
  const cases: [string, Partial<Promotion>, string, { totalUses: number; userUses: number }?][] = [
    ['inactiva', { active: false }, 'INACTIVE'],
    ['todavía no empezó', { startsAt: new Date('2026-06-01T00:00:00Z') }, 'NOT_STARTED'],
    ['ya terminó (el instante exacto de fin ya no vale)', { endsAt: NOW }, 'EXPIRED'],
    ['no llega al mínimo', { minSubtotalCents: 500_000 }, 'MIN_SUBTOTAL'],
    ['se agotaron los usos totales', { maxUses: 100 }, 'EXHAUSTED', { totalUses: 100, userUses: 0 }],
    ['la persona ya la usó', { maxUsesPerUser: 1 }, 'USER_LIMIT', { totalUses: 5, userUses: 1 }],
    ['porcentaje fuera de rango', { value: 150 }, 'INVALID'],
    ['valor cero o negativo', { value: 0 }, 'INVALID'],
  ];
  it.each(cases)('%s', (_n, extra, reason, usage) => {
    expect(applyPromotion(promo(extra), 100_000, NOW, usage)).toEqual({ ok: false, reason });
  });
  it('subtotal inválido (decimal o negativo) se rechaza', () => {
    expect(applyPromotion(promo(), 10.5, NOW)).toEqual({ ok: false, reason: 'INVALID' });
    expect(applyPromotion(promo(), -1, NOW)).toEqual({ ok: false, reason: 'INVALID' });
  });
  it('justo en el mínimo y justo antes del fin sí aplican', () => {
    expect(applyPromotion(promo({ minSubtotalCents: 100_000 }), 100_000, NOW).ok).toBe(true);
    expect(applyPromotion(promo({ endsAt: new Date(NOW.getTime() + 1) }), 100_000, NOW).ok).toBe(true);
  });
});

describe('elegir la mejor promoción (no se acumulan)', () => {
  it('elige la que más descuenta e ignora las que no aplican', () => {
    const list = [promo({ code: 'A', value: 10 }), promo({ code: 'B', kind: 'fixed', value: 300_000 }), promo({ code: 'C', value: 90, active: false })];
    expect(bestPromotion(list, 1_000_000, NOW)).toMatchObject({ code: 'B', discountCents: 300_000 });
  });
  it('en empate gana el código menor, para que el resultado sea estable', () => {
    const list = [promo({ code: 'Z', value: 10 }), promo({ code: 'M', value: 10 })];
    expect(bestPromotion(list, 100_000, NOW)).toMatchObject({ code: 'M' });
  });
  it('sin promociones aplicables devuelve null; respeta los usos por código', () => {
    expect(bestPromotion([], 100_000, NOW)).toBeNull();
    expect(bestPromotion([promo({ maxUsesPerUser: 1 })], 100_000, NOW, () => ({ totalUses: 1, userUses: 1 }))).toBeNull();
  });
});
