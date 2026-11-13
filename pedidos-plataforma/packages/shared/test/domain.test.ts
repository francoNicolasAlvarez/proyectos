import { describe, expect, it } from 'vitest';
import {
  CANCELLATION_REASONS, InvalidTransitionError, OPERATIONAL, PART, PricingError,
  assertOperationalTransition, assertPartTransition, assertPaymentTransition, checkCapacity, deriveFromParts,
  estimatePrepMinutes, isOpenAt, isTerminal, isVisibleToVenue, planParts, priceCart, priceLine, requiresRefund, resolvePickupPoint,
  type OperationalStatus, type ProductDef,
} from '../src';

describe('estados operativos', () => {
  it('recorre el camino feliz con los actores correctos', () => {
    assertOperationalTransition('awaiting_payment', 'pending_acceptance', 'provider');
    assertOperationalTransition('pending_acceptance', 'accepted', 'staff');
    assertOperationalTransition('accepted', 'preparing', 'staff');
    assertOperationalTransition('preparing', 'ready', 'staff');
    assertOperationalTransition('ready', 'delivered', 'staff');
  });

  it('no permite saltear pasos ni retroceder', () => {
    expect(() => assertOperationalTransition('pending_acceptance', 'ready', 'staff')).toThrow(InvalidTransitionError);
    expect(() => assertOperationalTransition('preparing', 'accepted', 'staff')).toThrow(InvalidTransitionError);
    expect(() => assertOperationalTransition('delivered', 'ready', 'staff')).toThrow(InvalidTransitionError);
  });

  it('los estados finales no tienen salida', () => {
    for (const s of ['delivered', 'rejected', 'cancelled', 'not_picked_up'] as OperationalStatus[]) {
      expect(isTerminal(s)).toBe(true);
      expect(Object.keys(OPERATIONAL[s])).toHaveLength(0);
    }
    expect(isTerminal('preparing')).toBe(false);
  });

  it('el cliente solo puede cancelar antes de la aceptación', () => {
    assertOperationalTransition('pending_acceptance', 'cancelled', 'customer');
    assertOperationalTransition('awaiting_payment', 'cancelled', 'customer');
    expect(() => assertOperationalTransition('accepted', 'cancelled', 'customer')).toThrow(/staff/);
    expect(() => assertOperationalTransition('preparing', 'cancelled', 'customer')).toThrow(InvalidTransitionError);
  });

  it('el cliente no puede aceptar ni entregar pedidos', () => {
    expect(() => assertOperationalTransition('pending_acceptance', 'accepted', 'customer')).toThrow(InvalidTransitionError);
    expect(() => assertOperationalTransition('ready', 'delivered', 'customer')).toThrow(InvalidTransitionError);
  });

  it('el sistema puede rechazar por timeout y aceptar automáticamente', () => {
    assertOperationalTransition('pending_acceptance', 'rejected', 'system');
    assertOperationalTransition('pending_acceptance', 'accepted', 'system');
  });

  it('el pedido solo es visible para el local una vez salido de awaiting_payment', () => {
    expect(isVisibleToVenue('awaiting_payment')).toBe(false);
    expect(isVisibleToVenue('pending_acceptance')).toBe(true);
  });

  it('el mensaje del error identifica el eje, los estados y el actor', () => {
    try { assertOperationalTransition('accepted', 'delivered', 'staff'); } catch (e) {
      expect(e).toBeInstanceOf(InvalidTransitionError);
      expect((e as Error).message).toContain('accepted → delivered');
      expect((e as InvalidTransitionError).axis).toBe('operational');
    }
  });
});

describe('estados de pago', () => {
  it('prepago: pendiente → aprobado → reembolso → reembolsado', () => {
    assertPaymentTransition('prepaid', 'pending', 'approved', 'provider');
    assertPaymentTransition('prepaid', 'approved', 'refund_pending', 'system');
    assertPaymentTransition('prepaid', 'refund_pending', 'refunded', 'provider');
  });

  it('el cliente nunca puede aprobar un pago ni reembolsar', () => {
    expect(() => assertPaymentTransition('prepaid', 'pending', 'approved', 'customer')).toThrow(InvalidTransitionError);
    expect(() => assertPaymentTransition('prepaid', 'approved', 'refund_pending', 'customer')).toThrow(InvalidTransitionError);
  });

  it('un pago rechazado o expirado no puede aprobarse después', () => {
    expect(() => assertPaymentTransition('prepaid', 'rejected', 'approved', 'provider')).toThrow(InvalidTransitionError);
    expect(() => assertPaymentTransition('prepaid', 'expired', 'approved', 'provider')).toThrow(InvalidTransitionError);
  });

  it('un reembolso parcial puede completarse con otro reembolso', () => {
    assertPaymentTransition('prepaid', 'refund_pending', 'partially_refunded', 'provider');
    assertPaymentTransition('prepaid', 'partially_refunded', 'refund_pending', 'staff');
  });

  it('pago al retiro: solo el empleado confirma el cobro, y no hay reembolsos', () => {
    assertPaymentTransition('on_pickup', 'pending_collection', 'collected_on_pickup', 'staff');
    expect(() => assertPaymentTransition('on_pickup', 'pending_collection', 'collected_on_pickup', 'customer')).toThrow(InvalidTransitionError);
    expect(() => assertPaymentTransition('on_pickup', 'collected_on_pickup', 'refund_pending', 'staff')).toThrow(InvalidTransitionError);
  });

  it('los estados de un tipo de pago no se mezclan con los del otro', () => {
    expect(() => assertPaymentTransition('prepaid', 'pending_collection', 'collected_on_pickup', 'staff')).toThrow(InvalidTransitionError);
    expect(() => assertPaymentTransition('on_pickup', 'pending', 'approved', 'provider')).toThrow(InvalidTransitionError);
  });
});

describe('reembolsos', () => {
  const paid = { paymentTiming: 'prepaid', paymentStatus: 'approved' } as const;
  it('rechazar o cancelar un pedido prepago cobrado exige reembolso', () => {
    expect(requiresRefund(paid, 'rejected')).toBe(true);
    expect(requiresRefund(paid, 'cancelled')).toBe(true);
  });
  it('no exige reembolso si no hay cobro previo o si se entrega', () => {
    expect(requiresRefund({ paymentTiming: 'prepaid', paymentStatus: 'pending' }, 'cancelled')).toBe(false);
    expect(requiresRefund({ paymentTiming: 'on_pickup', paymentStatus: 'pending_collection' }, 'rejected')).toBe(false);
    expect(requiresRefund(paid, 'delivered')).toBe(false);
  });
  it('hay un motivo predefinido para cada caso del análisis funcional', () => {
    expect(Object.keys(CANCELLATION_REASONS)).toHaveLength(6);
  });
});

describe('partes de retiro', () => {
  it('transiciones válidas de una parte', () => {
    assertPartTransition('pending', 'preparing', 'staff');
    assertPartTransition('preparing', 'ready', 'staff');
    assertPartTransition('ready', 'delivered', 'staff');
    expect(() => assertPartTransition('ready', 'preparing', 'staff')).toThrow(InvalidTransitionError);
    expect(Object.keys(PART.delivered)).toHaveLength(0);
  });

  it.each([
    [['preparing', 'preparing'], 'preparing'],
    [['ready', 'preparing'], 'preparing'],
    [['ready', 'ready'], 'ready'],
    [['ready', 'delivered'], 'ready'],
    [['delivered', 'delivered'], 'delivered'],
    [['delivered', 'not_picked_up'], 'not_picked_up'],
    [['ready', 'cancelled'], 'ready'],
    [['cancelled', 'cancelled'], 'cancelled'],
    [['pending', 'pending'], null],
    [[], null],
  ] as const)('estado del pedido derivado de las partes %j → %s', (parts, expected) => {
    expect(deriveFromParts(parts as never)).toBe(expected);
  });

  const items = [
    { name: 'Rubia', pickupPointId: 'barra' },
    { name: 'Papas', pickupPointId: 'cocina' },
    { name: 'IPA', pickupPointId: 'barra' },
  ];

  it('single_point con varios puntos: una parte sin punto (lo asigna el empleado al marcar listo)', () => {
    const plan = planParts(items, 'single_point', ['barra', 'cocina']);
    expect(plan).toHaveLength(1);
    expect(plan[0]?.pickupPointId).toBeNull();
    expect(plan[0]?.items).toHaveLength(3);
  });

  it('single_point con un único punto activo: se asigna al crear', () => {
    expect(planParts(items, 'single_point', ['barra'])[0]?.pickupPointId).toBe('barra');
  });

  it('per_item: una parte por punto, agrupando los ítems del mismo punto', () => {
    const plan = planParts(items, 'per_item', ['barra', 'cocina']);
    expect(plan).toHaveLength(2);
    expect(plan.find((p) => p.pickupPointId === 'barra')?.items.map((i) => i.name)).toEqual(['Rubia', 'IPA']);
  });

  it('sin ítems no hay partes', () => {
    expect(planParts([], 'per_item', ['barra'])).toEqual([]);
  });

  it('el punto se resuelve: producto → categoría → por defecto', () => {
    expect(resolvePickupPoint('p', 'c', 'd')).toBe('p');
    expect(resolvePickupPoint(null, 'c', 'd')).toBe('c');
    expect(resolvePickupPoint(undefined, null, 'd')).toBe('d');
    expect(resolvePickupPoint(null, null, null)).toBeNull();
  });
});

describe('precios', () => {
  const beer: ProductDef = {
    id: 'beer', name: 'Rubia', basePriceCents: 420_000, available: true, prepMinutes: 2,
    groups: [{ id: 'size', name: 'Tamaño', minSelect: 1, maxSelect: 1, options: [
      { id: 'pint', priceDeltaCents: 0, available: true }, { id: 'liter', priceDeltaCents: 380_000, available: true },
      { id: 'xl', priceDeltaCents: 900_000, available: false } ] }],
  };
  const lemonade: ProductDef = {
    id: 'lem', name: 'Limonada', basePriceCents: 320_000, available: true, prepMinutes: 3,
    groups: [{ id: 'extra', name: 'Agregados', minSelect: 0, maxSelect: 2, options: [
      { id: 'ginger', priceDeltaCents: 30_000, available: true }, { id: 'mint', priceDeltaCents: 30_000, available: true },
      { id: 'honey', priceDeltaCents: 50_000, available: true } ] }],
  };
  const catalog = new Map([[beer.id, beer], [lemonade.id, lemonade]]);
  const err = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as PricingError).code; } return null; };

  it('suma el precio base y los extras de las opciones, por cantidad', () => {
    const l = priceLine(beer, { productId: 'beer', quantity: 3, selections: { size: ['liter'] } });
    expect(l.unitPriceCents).toBe(800_000);
    expect(l.lineTotalCents).toBe(2_400_000);
    expect(l.chosen).toEqual([{ groupId: 'size', groupName: 'Tamaño', optionId: 'liter', priceDeltaCents: 380_000 }]);
  });

  it('exige las opciones obligatorias y respeta el máximo', () => {
    expect(err(() => priceLine(beer, { productId: 'beer', quantity: 1, selections: {} }))).toBe('SELECTION_BELOW_MIN');
    expect(err(() => priceLine(beer, { productId: 'beer', quantity: 1, selections: { size: ['pint', 'liter'] } }))).toBe('SELECTION_ABOVE_MAX');
    expect(err(() => priceLine(lemonade, { productId: 'lem', quantity: 1, selections: { extra: ['ginger', 'mint', 'honey'] } }))).toBe('SELECTION_ABOVE_MAX');
    expect(priceLine(lemonade, { productId: 'lem', quantity: 1, selections: {} }).unitPriceCents).toBe(320_000);
  });

  it('rechaza opciones inexistentes, agotadas, repetidas o de otro grupo', () => {
    expect(err(() => priceLine(beer, { productId: 'beer', quantity: 1, selections: { size: ['nope'] } }))).toBe('UNKNOWN_OPTION');
    expect(err(() => priceLine(beer, { productId: 'beer', quantity: 1, selections: { size: ['xl'] } }))).toBe('OPTION_UNAVAILABLE');
    expect(err(() => priceLine(lemonade, { productId: 'lem', quantity: 1, selections: { extra: ['mint', 'mint'] } }))).toBe('DUPLICATE_OPTION');
    expect(err(() => priceLine(beer, { productId: 'beer', quantity: 1, selections: { size: ['pint'], hack: ['x'] } }))).toBe('UNKNOWN_GROUP');
  });

  it.each([0, -1, 1.5, 51, Number.NaN])('rechaza la cantidad %s', (q) => {
    expect(err(() => priceLine(beer, { productId: 'beer', quantity: q, selections: { size: ['pint'] } }))).toBe('INVALID_QUANTITY');
  });

  it('rechaza productos agotados, archivados, de categoría pausada o inexistentes', () => {
    const sel = { size: ['pint'] };
    expect(err(() => priceLine({ ...beer, available: false }, { productId: 'beer', quantity: 1, selections: sel }))).toBe('PRODUCT_UNAVAILABLE');
    expect(err(() => priceLine({ ...beer, archived: true }, { productId: 'beer', quantity: 1, selections: sel }))).toBe('PRODUCT_UNAVAILABLE');
    expect(err(() => priceLine({ ...beer, categoryPaused: true }, { productId: 'beer', quantity: 1, selections: sel }))).toBe('PRODUCT_UNAVAILABLE');
    expect(err(() => priceLine(undefined, { productId: 'ghost', quantity: 1, selections: {} }))).toBe('UNKNOWN_PRODUCT');
  });

  it('calcula el subtotal del carrito y rechaza carritos vacíos', () => {
    const cart = priceCart(catalog, [
      { productId: 'beer', quantity: 2, selections: { size: ['pint'] } },
      { productId: 'lem', quantity: 1, selections: { extra: ['ginger'] } },
    ]);
    expect(cart.subtotalCents).toBe(2 * 420_000 + 350_000);
    expect(err(() => priceCart(catalog, []))).toBe('EMPTY_CART');
  });

  it('los importes son enteros (sin errores de punto flotante)', () => {
    const l = priceLine(lemonade, { productId: 'lem', quantity: 3, selections: { extra: ['ginger', 'mint'] } });
    expect(Number.isInteger(l.lineTotalCents)).toBe(true);
    expect(l.lineTotalCents).toBe(3 * 380_000);
  });

  it('el tiempo estimado es el mayor tiempo de preparación', () => {
    expect(estimatePrepMinutes([beer, lemonade])).toBe(3);
    expect(estimatePrepMinutes([])).toBe(0);
  });
});

describe('capacidad y horarios', () => {
  const base = { paused: false, isOpen: true, activeOrders: 0, ordersInCurrentInterval: 0 };
  it('acepta pedidos si no hay límites', () => { expect(checkCapacity(base)).toEqual({ ok: true }); });
  it('rechaza si está pausado o cerrado, con prioridad sobre los límites', () => {
    expect(checkCapacity({ ...base, paused: true })).toEqual({ ok: false, reason: 'PAUSED' });
    expect(checkCapacity({ ...base, isOpen: false })).toEqual({ ok: false, reason: 'CLOSED' });
  });
  it('respeta el límite de pedidos simultáneos', () => {
    expect(checkCapacity({ ...base, maxConcurrentOrders: 10, activeOrders: 9 })).toEqual({ ok: true });
    expect(checkCapacity({ ...base, maxConcurrentOrders: 10, activeOrders: 10 })).toEqual({ ok: false, reason: 'CONCURRENT_LIMIT' });
  });
  it('respeta el límite por intervalo', () => {
    expect(checkCapacity({ ...base, maxOrdersPerInterval: 5, ordersInCurrentInterval: 5 })).toEqual({ ok: false, reason: 'INTERVAL_LIMIT' });
  });

  const hours = [{ weekday: 5, opens: '20:00', closes: '02:00' }, { weekday: 3, opens: '12:00', closes: '16:00' }];
  it('sin horarios configurados siempre está abierto', () => { expect(isOpenAt([], 1, 0)).toBe(true); });
  it('franja dentro del mismo día', () => {
    expect(isOpenAt(hours, 3, 12 * 60)).toBe(true);
    expect(isOpenAt(hours, 3, 16 * 60)).toBe(false);
    expect(isOpenAt(hours, 3, 11 * 60 + 59)).toBe(false);
  });
  it('franja que cruza la medianoche sigue abierta el día siguiente hasta el cierre', () => {
    expect(isOpenAt(hours, 5, 23 * 60)).toBe(true);    // viernes 23:00
    expect(isOpenAt(hours, 6, 60)).toBe(true);          // sábado 01:00 (viernes noche)
    expect(isOpenAt(hours, 6, 2 * 60)).toBe(false);     // sábado 02:00 ya cerró
    expect(isOpenAt(hours, 4, 23 * 60)).toBe(false);    // jueves no abre
  });
  it('la franja del sábado cruza hacia el domingo (vuelta de semana)', () => {
    expect(isOpenAt([{ weekday: 6, opens: '22:00', closes: '03:00' }], 0, 120)).toBe(true);
  });
});
