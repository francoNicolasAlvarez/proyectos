import { describe, expect, it } from 'vitest';
import { DEFAULT_ON_PICKUP_MAX_TOTAL_CENTS, DEFAULT_ORDER_LIMITS, LIMITS_REVIEW_DAYS, OrderLimitError, checkLimitsConsistency, limitsFor, limitsReviewDue, orderLimitViolations, orderUsage, priceCart, type ProductDef } from '../src';

const single = (quantity: number, lineTotalCents = 100_000) => ({ kind: 'simple' as const, quantity, lineTotalCents });
const combo = (quantity: number, lineTotalCents = 100_000) => ({ kind: 'combo' as const, quantity, lineTotalCents });
const codes = (lines: Parameters<typeof orderLimitViolations>[0], limits?: Parameters<typeof orderLimitViolations>[1]) => orderLimitViolations(lines, limits).map((v) => v.code);

describe('límite de gasto por pedido', () => {
  it('los valores por defecto son $100.000, 20 productos o 8 combos', () => {
    expect(DEFAULT_ORDER_LIMITS).toEqual({ maxTotalCents: 10_000_000, maxIndividualItems: 20, maxCombos: 8 });
  });

  it('exactamente $100.000 se permite; un centavo más no', () => {
    expect(codes([single(1, 10_000_000)])).toEqual([]);
    const v = orderLimitViolations([single(1, 10_000_001)]);
    expect(v).toEqual([{ code: 'ORDER_TOTAL_LIMIT_EXCEEDED', limit: 10_000_000, actual: 10_000_001 }]);
  });

  it('suma todas las líneas, no cada una por separado', () => {
    expect(codes([single(1, 6_000_000), single(1, 4_000_000)])).toEqual([]);
    expect(codes([single(1, 6_000_000), single(1, 4_000_001)])).toEqual(['ORDER_TOTAL_LIMIT_EXCEEDED']);
  });
});

describe('límite de cantidad por pedido', () => {
  it('20 productos individuales se permiten; 21 no', () => {
    expect(codes([single(20)])).toEqual([]);
    expect(codes([single(21)])).toEqual(['ORDER_ITEM_LIMIT_EXCEEDED']);
  });

  it('8 combos se permiten; 9 no', () => {
    expect(codes([combo(8)])).toEqual([]);
    expect(codes([combo(9)])).toEqual(['ORDER_ITEM_LIMIT_EXCEEDED']);
  });

  it('la cantidad se cuenta entre líneas distintas (no por línea)', () => {
    // Un puesto sin combos: papas, gaseosas y plato principal
    expect(codes([single(8), single(7), single(5)])).toEqual([]);          // 20
    expect(codes([single(8), single(7), single(6)])).toEqual(['ORDER_ITEM_LIMIT_EXCEEDED']);   // 21
  });

  it('mezclar combos e individuales: un combo equivale a 2,5 productos', () => {
    expect(orderUsage([combo(1)]).equivalentItems).toBe(2.5);
    expect(codes([combo(5), single(7)])).toEqual([]);                      // 12,5 + 7 = 19,5
    expect(codes([combo(5), single(8)])).toEqual(['ORDER_ITEM_LIMIT_EXCEEDED']);   // 20,5
    expect(codes([combo(1), single(17)])).toEqual([]);                     // 19,5
    expect(codes([combo(1), single(18)])).toEqual(['ORDER_ITEM_LIMIT_EXCEEDED']);  // 20,5
    expect(codes([combo(8), single(1)])).toEqual(['ORDER_ITEM_LIMIT_EXCEEDED']);   // 8 combos ya agotan el cupo
  });

  it('informa el uso en productos equivalentes', () => {
    const v = orderLimitViolations([combo(5), single(8)]);
    expect(v).toEqual([{ code: 'ORDER_ITEM_LIMIT_EXCEEDED', limit: 20, actual: 20.5 }]);
    expect(orderUsage([combo(5), single(8)])).toMatchObject({ individualItems: 8, combos: 5, equivalentItems: 20.5 });
  });
});

describe('ambos límites juntos', () => {
  it('informa todas las reglas incumplidas, el gasto primero', () => {
    expect(codes([single(25, 11_000_000)])).toEqual(['ORDER_TOTAL_LIMIT_EXCEEDED', 'ORDER_ITEM_LIMIT_EXCEEDED']);
  });

  it('con combos de más de $12.500 el tope de gasto salta antes que el de 8 combos', () => {
    // 8 × $12.900 = $103.200
    expect(codes([combo(8, 1_290_000 * 8)])).toEqual(['ORDER_TOTAL_LIMIT_EXCEEDED']);
    // 7 × $12.900 = $90.300: permitido
    expect(codes([combo(7, 1_290_000 * 7)])).toEqual([]);
  });

  it('con productos baratos manda el tope de cantidad, no el de gasto', () => {
    // 21 × $4.200 = $88.200
    expect(codes([single(21, 420_000 * 21)])).toEqual(['ORDER_ITEM_LIMIT_EXCEEDED']);
  });
});

describe('límites propios de cada local', () => {
  const custom = { maxTotalCents: 30_000_000, maxIndividualItems: 50, maxCombos: 10 };
  it('se pueden ampliar', () => {
    expect(codes([single(50, 1_000_000)], custom)).toEqual([]);
    expect(codes([single(51, 1_000_000)], custom)).toEqual(['ORDER_ITEM_LIMIT_EXCEEDED']);
    expect(codes([combo(10)], custom)).toEqual([]);
    expect(codes([combo(11)], custom)).toEqual(['ORDER_ITEM_LIMIT_EXCEEDED']);
    expect(orderUsage([combo(1)], custom).equivalentItems).toBe(5);     // 50 / 10
  });
  it('rechaza configuraciones inválidas', () => {
    expect(() => orderLimitViolations([single(1)], { maxTotalCents: 0, maxIndividualItems: 20, maxCombos: 8 })).toThrow();
    expect(() => orderLimitViolations([single(1)], { maxTotalCents: 1, maxIndividualItems: 0, maxCombos: 8 })).toThrow();
    expect(() => orderLimitViolations([single(1)], { maxTotalCents: 1, maxIndividualItems: 20, maxCombos: 0 })).toThrow();
  });
});

describe('priceCart aplica los límites', () => {
  const fries: ProductDef = { id: 'f', name: 'Papas', basePriceCents: 520_000, available: true, prepMinutes: 12, groups: [] };
  const combo3: ProductDef = { id: 'c', name: 'Combo 3', basePriceCents: 1_290_000, available: true, prepMinutes: 12, kind: 'combo', groups: [] };
  const catalog = new Map([[fries.id, fries], [combo3.id, combo3]]);
  const run = (lines: { productId: string; quantity: number }[], limits?: Parameters<typeof priceCart>[2]) =>
    priceCart(catalog, lines.map((l) => ({ ...l, selections: {} })), limits);
  const err = (fn: () => unknown) => { try { fn(); } catch (e) { return e as OrderLimitError; } return null; };

  it('devuelve el uso cuando el pedido cumple', () => {
    expect(run([{ productId: 'f', quantity: 10 }, { productId: 'c', quantity: 2 }]).usage).toMatchObject({ individualItems: 10, combos: 2, equivalentItems: 15, totalCents: 10 * 520_000 + 2 * 1_290_000 });
  });

  it('usa el tipo del producto para distinguir combos', () => {
    expect(err(() => run([{ productId: 'c', quantity: 9 }]))?.violations.map((v) => v.code)).toContain('ORDER_ITEM_LIMIT_EXCEEDED');
    expect(err(() => run([{ productId: 'f', quantity: 9 }]))).toBeNull();
  });

  it('lanza OrderLimitError con el detalle de lo que se superó', () => {
    const e = err(() => run([{ productId: 'c', quantity: 8 }]));
    expect(e).toBeInstanceOf(OrderLimitError);
    expect(e?.code).toBe('ORDER_TOTAL_LIMIT_EXCEEDED');
    expect(e?.violations).toEqual([{ code: 'ORDER_TOTAL_LIMIT_EXCEEDED', limit: 10_000_000, actual: 10_320_000 }]);
    expect(e?.usage).toMatchObject({ combos: 8, equivalentItems: 20 });
  });

  it('acepta límites distintos por local', () => {
    expect(err(() => run([{ productId: 'c', quantity: 8 }], { maxTotalCents: 20_000_000, maxIndividualItems: 20, maxCombos: 8 }))).toBeNull();
  });
});

describe('el límite suma los pedidos abiertos de la persona (no se esquiva partiendo la compra)', () => {
  const prior = (individualItems: number, combos: number, totalCents: number) => ({ individualItems, combos, totalCents });

  it('un pedido chico que cumple solo, falla si con los abiertos supera el gasto', () => {
    expect(codes([single(1, 1_000_000)])).toEqual([]);                                  // $10.000 solo: bien
    const v = orderLimitViolations([single(1, 1_000_000)], DEFAULT_ORDER_LIMITS, prior(5, 0, 9_500_000));   // ya tiene $95.000 abiertos
    expect(v).toEqual([{ code: 'ORDER_TOTAL_LIMIT_EXCEEDED', limit: 10_000_000, actual: 10_500_000, alreadyOpen: 9_500_000 }]);
  });

  it('también suma la cantidad, contando cada combo abierto como 2,5 productos', () => {
    const v = orderLimitViolations([single(2)], DEFAULT_ORDER_LIMITS, prior(10, 3, 1_000_000));    // 10 + 7,5 abiertos + 2 = 19,5 → bien
    expect(v).toEqual([]);
    const over = orderLimitViolations([single(3)], DEFAULT_ORDER_LIMITS, prior(10, 3, 1_000_000)); // 20,5
    expect(over).toEqual([{ code: 'ORDER_ITEM_LIMIT_EXCEEDED', limit: 20, actual: 20.5, alreadyOpen: 17.5 }]);
  });

  it('sin pedidos abiertos todo funciona como antes (sin campos extra)', () => {
    expect(orderLimitViolations([single(21)], DEFAULT_ORDER_LIMITS, prior(0, 0, 0))).toEqual([{ code: 'ORDER_ITEM_LIMIT_EXCEEDED', limit: 20, actual: 21 }]);
    expect(orderUsage([single(1)], DEFAULT_ORDER_LIMITS, prior(0, 0, 0)).openOrders).toBeUndefined();
  });

  it('el uso informa los pedidos abiertos', () => {
    expect(orderUsage([single(2, 500_000)], DEFAULT_ORDER_LIMITS, prior(4, 1, 2_000_000))).toMatchObject({
      individualItems: 6, combos: 1, totalCents: 2_500_000, openOrders: { individualItems: 4, combos: 1, totalCents: 2_000_000 },
    });
  });

  it('priceCart rechaza el pedido nuevo cuando con los abiertos supera el tope', () => {
    const fries: ProductDef = { id: 'f', name: 'Papas', basePriceCents: 520_000, available: true, prepMinutes: 1, groups: [] };
    const run = (p?: ReturnType<typeof prior>) => priceCart(new Map([['f', fries]]), [{ productId: 'f', quantity: 2, selections: {} }], DEFAULT_ORDER_LIMITS, p);
    expect(() => run()).not.toThrow();
    expect(() => run(prior(10, 0, 9_500_000))).toThrow(OrderLimitError);
  });
});

describe('coherencia de los límites con el catálogo', () => {
  const cat = (name: string, kind: 'simple' | 'combo', priceCents: number) => ({ name, kind, priceCents });
  it('avisa que con un combo de $12.900 no se llegan a 8 combos (solo 7)', () => {
    const issues = checkLimitsConsistency(DEFAULT_ORDER_LIMITS, [cat('Combo 3', 'combo', 1_290_000)]);
    expect(issues).toEqual([{ code: 'COMBO_LIMIT_UNREACHABLE', severity: 'warning', product: 'Combo 3', maxReachable: 7 }]);
  });
  it('un combo de $12.500 o menos llega justo a 8 y no genera aviso', () => {
    expect(checkLimitsConsistency(DEFAULT_ORDER_LIMITS, [cat('Combo', 'combo', 1_250_000)])).toEqual([]);
    expect(checkLimitsConsistency(DEFAULT_ORDER_LIMITS, [cat('Combo', 'combo', 1_250_001)])).toHaveLength(1);
  });
  it('un producto que cuesta más que el tope es un error (no se puede comprar nunca)', () => {
    const issues = checkLimitsConsistency(DEFAULT_ORDER_LIMITS, [cat('Botella premium', 'simple', 12_000_000)]);
    expect(issues).toEqual([{ code: 'PRODUCT_EXCEEDS_TOTAL', severity: 'error', product: 'Botella premium', maxReachable: 0 }]);
  });
  it('si ni el producto más barato permite 20 unidades, informa que manda el gasto', () => {
    const issues = checkLimitsConsistency(DEFAULT_ORDER_LIMITS, [cat('Trago', 'simple', 600_000), cat('Pinta', 'simple', 550_000)]);
    expect(issues).toEqual([{ code: 'ITEM_LIMIT_UNREACHABLE', severity: 'info', product: 'Pinta', maxReachable: 18 }]);
  });
  it('un catálogo coherente no genera avisos', () => {
    expect(checkLimitsConsistency(DEFAULT_ORDER_LIMITS, [cat('Pinta', 'simple', 420_000), cat('Combo', 'combo', 1_000_000)])).toEqual([]);
    expect(checkLimitsConsistency(DEFAULT_ORDER_LIMITS, [])).toEqual([]);
  });
  it('subir el tope resuelve el aviso', () => {
    expect(checkLimitsConsistency({ ...DEFAULT_ORDER_LIMITS, maxTotalCents: 11_000_000 }, [cat('Combo 3', 'combo', 1_290_000)])).toEqual([]);
  });
});

describe('inflación: revisión periódica y pago al retiro', () => {
  it('pide revisar los límites pasados 60 días', () => {
    const now = new Date('2030-06-01T00:00:00Z');
    expect(LIMITS_REVIEW_DAYS).toBe(60);
    expect(limitsReviewDue(new Date('2030-04-15T00:00:00Z'), now)).toBe(false);   // 47 días
    expect(limitsReviewDue(new Date('2030-03-01T00:00:00Z'), now)).toBe(true);    // 92 días
  });
  it('el pago al retiro tiene un tope de gasto menor, nunca mayor que el del pago anticipado', () => {
    expect(DEFAULT_ON_PICKUP_MAX_TOTAL_CENTS).toBe(3_000_000);
    expect(limitsFor(DEFAULT_ORDER_LIMITS, 'prepaid').maxTotalCents).toBe(10_000_000);
    expect(limitsFor(DEFAULT_ORDER_LIMITS, 'on_pickup').maxTotalCents).toBe(3_000_000);
    expect(limitsFor({ ...DEFAULT_ORDER_LIMITS, maxTotalOnPickupCents: 5_000_000 }, 'on_pickup').maxTotalCents).toBe(5_000_000);
    // si el local baja su tope general por debajo del de retiro, manda el menor
    expect(limitsFor({ ...DEFAULT_ORDER_LIMITS, maxTotalCents: 2_000_000, maxTotalOnPickupCents: 5_000_000 }, 'on_pickup').maxTotalCents).toBe(2_000_000);
    expect(limitsFor(DEFAULT_ORDER_LIMITS, 'on_pickup').maxIndividualItems).toBe(20);
  });
});
