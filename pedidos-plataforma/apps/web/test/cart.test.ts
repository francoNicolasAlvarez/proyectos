import { describe, expect, it } from 'vitest';
import type { Product } from '../src/api/types';
import { cartReducer, cartViolations, EMPTY_CART, lineId, selectionProblems, subtotal, toOrderRequest, unitPrice, type CartState } from '../src/lib/cart';

const beer: Product = {
  id: 'p-beer', name: 'Rubia Lager', description: null, ingredients: null, imageUrl: null, priceCents: 400_000, prepMinutes: 2, available: true, kind: 'simple',
  groups: [
    { id: 'g-size', name: 'Tamaño', min: 1, max: 1, options: [{ id: 'o-pinta', name: 'Pinta', priceDeltaCents: 0, available: true }, { id: 'o-jarra', name: 'Jarra', priceDeltaCents: 300_000, available: true }] },
    { id: 'g-extra', name: 'Extras', min: 0, max: 2, options: [{ id: 'o-mani', name: 'Maní', priceDeltaCents: 50_000, available: true }, { id: 'o-papas', name: 'Papas', priceDeltaCents: 80_000, available: true }, { id: 'o-pan', name: 'Pan', priceDeltaCents: 0, available: true }] },
  ],
};
const combo: Product = { ...beer, id: 'p-combo', name: 'Combo 3', kind: 'combo', priceCents: 1_290_000, groups: [] };
const limits = { maxTotalCents: 10_000_000, maxIndividualItems: 20, maxCombos: 8 };

const add = (s: CartState, p: Product, selections: Record<string, string[]>, quantity = 1) => cartReducer(s, { type: 'add', product: p, selections, quantity });

describe('precio y resumen de una línea', () => {
  it('suma los sobreprecios de las opciones elegidas', () => {
    expect(unitPrice(beer, { 'g-size': ['o-jarra'], 'g-extra': ['o-mani', 'o-papas'] })).toBe(400_000 + 300_000 + 50_000 + 80_000);
    expect(unitPrice(beer, {})).toBe(400_000);
  });
  it('el texto resumen muestra grupo y opciones', () => {
    const s = add(EMPTY_CART, beer, { 'g-size': ['o-pinta'], 'g-extra': ['o-mani'] });
    expect(s.lines[0]?.summary).toBe('Tamaño: Pinta · Extras: Maní');
  });
});

describe('validación de la selección (escenario → resultado)', () => {
  it('un grupo obligatorio sin elegir se marca', () => {
    expect(selectionProblems(beer.groups, {}).map((p) => p.groupId)).toEqual(['g-size']);
    expect(selectionProblems(beer.groups, {})[0]?.message).toBe('Elegí una opción de "Tamaño"');
  });
  it('elegir de más se marca; dentro del rango es válido', () => {
    expect(selectionProblems(beer.groups, { 'g-size': ['o-pinta'], 'g-extra': ['o-mani', 'o-papas', 'o-pan'] }).map((p) => p.groupId)).toEqual(['g-extra']);
    expect(selectionProblems(beer.groups, { 'g-size': ['o-pinta'], 'g-extra': ['o-mani'] })).toEqual([]);
  });
  it('un producto sin grupos siempre es válido', () => {
    expect(selectionProblems(combo.groups, {})).toEqual([]);
  });
});

describe('carrito', () => {
  it('lo mismo con las mismas opciones suma cantidad; distintas opciones son otra línea', () => {
    let s = add(EMPTY_CART, beer, { 'g-size': ['o-pinta'] });
    s = add(s, beer, { 'g-size': ['o-pinta'] }, 2);
    s = add(s, beer, { 'g-size': ['o-jarra'] });
    expect(s.lines.map((l) => l.quantity)).toEqual([3, 1]);
  });
  it('el orden de las opciones no crea líneas distintas', () => {
    expect(lineId('p', { a: ['2', '1'], b: [] })).toBe(lineId('p', { a: ['1', '2'] }));
  });
  it('cantidad: tope de 50 por línea; llegar a 0 quita la línea', () => {
    let s = add(EMPTY_CART, combo, {}, 60);
    expect(s.lines[0]?.quantity).toBe(50);
    s = cartReducer(s, { type: 'setQuantity', id: s.lines[0]!.id, quantity: 0 });
    expect(s.lines).toEqual([]);
  });
  it('cualquier cambio descarta la clave de idempotencia; fijar el intento la conserva', () => {
    let s = cartReducer(add(EMPTY_CART, combo, {}), { type: 'attempt', key: 'abc-12345' });
    expect(s.attemptKey).toBe('abc-12345');
    s = add(s, beer, { 'g-size': ['o-pinta'] });
    expect(s.attemptKey).toBeNull();
  });
  it('vaciar deja el carrito inicial', () => {
    expect(cartReducer(add(EMPTY_CART, combo, {}), { type: 'clear' })).toEqual(EMPTY_CART);
  });
  it('el subtotal suma precio × cantidad en centavos enteros', () => {
    const s = add(add(EMPTY_CART, combo, {}, 2), beer, { 'g-size': ['o-jarra'] });
    expect(subtotal(s.lines)).toBe(2 * 1_290_000 + 700_000);
  });
});

describe('límites del pedido (mismos topes que valida la API)', () => {
  it('8 combos de $12.900 superan el monto máximo de $100.000', () => {
    const s = add(EMPTY_CART, combo, {}, 8);
    expect(cartViolations(s.lines, limits).map((v) => v.code)).toEqual(['ORDER_TOTAL_LIMIT_EXCEEDED']);
  });
  it('9 combos superan también la cantidad (cada combo cuenta 2,5)', () => {
    const cheap = { ...combo, priceCents: 100_000 };
    expect(cartViolations(add(EMPTY_CART, cheap, {}, 8).lines, limits)).toEqual([]);
    expect(cartViolations(add(EMPTY_CART, cheap, {}, 9).lines, limits).map((v) => v.code)).toEqual(['ORDER_ITEM_LIMIT_EXCEEDED']);
  });
  it('21 productos individuales superan el tope de 20', () => {
    const cheap = { ...beer, groups: [], priceCents: 100_000 };
    expect(cartViolations(add(EMPTY_CART, cheap, {}, 20).lines, limits)).toEqual([]);
    expect(cartViolations(add(EMPTY_CART, cheap, {}, 21).lines, limits).map((v) => v.code)).toEqual(['ORDER_ITEM_LIMIT_EXCEEDED']);
  });
});

describe('cuerpo del pedido', () => {
  it('omite grupos vacíos y el origen cuando no hay', () => {
    const s = add(EMPTY_CART, beer, { 'g-size': ['o-pinta'], 'g-extra': [] }, 2);
    expect(toOrderRequest(s.lines, null, 'card_online')).toEqual({
      paymentMethod: 'card_online', items: [{ productId: 'p-beer', quantity: 2, selections: { 'g-size': ['o-pinta'] } }],
    });
  });
  it('incluye el sector de origen cuando el cliente escaneó un QR', () => {
    const s = add(EMPTY_CART, combo, {});
    expect(toOrderRequest(s.lines, 'loc-1', 'payment_app')).toMatchObject({ originLocationId: 'loc-1', paymentMethod: 'payment_app' });
  });
});
