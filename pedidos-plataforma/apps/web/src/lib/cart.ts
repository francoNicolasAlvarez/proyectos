/** Lógica pura del carrito (sin React): fácil de probar. Los precios se calculan en centavos enteros. */
import { MAX_QUANTITY_PER_LINE, orderLimitViolations, orderUsage, type LimitViolation, type OrderLimits } from '@pasamanos/shared';
import type { OptionGroup, OrderRequest, Product } from '../api/types';

export type Selections = Record<string, string[]>;

export interface CartLine {
  /** Identifica producto + opciones: agregar lo mismo suma cantidad. */
  id: string;
  productId: string; name: string; kind: 'simple' | 'combo';
  unitCents: number; quantity: number;
  selections: Selections;
  /** Texto legible de las opciones elegidas, p. ej. "Tamaño: Pinta · Extras: Queso". */
  summary: string;
}

export interface CartState {
  lines: CartLine[];
  /** Clave de idempotencia del intento de pago en curso; se descarta al cambiar el carrito. */
  attemptKey: string | null;
}

export const EMPTY_CART: CartState = { lines: [], attemptKey: null };

/** Clave estable: ignora el orden de las opciones elegidas. */
export function lineId(productId: string, selections: Selections): string {
  const parts = Object.keys(selections).sort().filter((g) => (selections[g]?.length ?? 0) > 0)
    .map((g) => `${g}=${[...(selections[g] ?? [])].sort().join(',')}`);
  return `${productId}|${parts.join(';')}`;
}

/** Problemas de una selección contra los grupos del producto (lista vacía si es válida). */
export function selectionProblems(groups: readonly OptionGroup[], selections: Selections): { groupId: string; message: string }[] {
  const out: { groupId: string; message: string }[] = [];
  for (const g of groups) {
    const n = selections[g.id]?.length ?? 0;
    if (n < g.min) out.push({ groupId: g.id, message: g.min === 1 && g.max === 1 ? `Elegí una opción de "${g.name}"` : `Elegí al menos ${g.min} en "${g.name}"` });
    else if (n > g.max) out.push({ groupId: g.id, message: `Elegí como máximo ${g.max} en "${g.name}"` });
  }
  return out;
}

export function unitPrice(product: Product, selections: Selections): number {
  let cents = product.priceCents;
  for (const g of product.groups) for (const oid of selections[g.id] ?? []) cents += g.options.find((o) => o.id === oid)?.priceDeltaCents ?? 0;
  return cents;
}

export function summarize(product: Product, selections: Selections): string {
  return product.groups
    .map((g) => {
      const names = (selections[g.id] ?? []).map((oid) => g.options.find((o) => o.id === oid)?.name).filter(Boolean);
      return names.length ? `${g.name}: ${names.join(', ')}` : '';
    })
    .filter(Boolean).join(' · ');
}

export type CartAction =
  | { type: 'add'; product: Product; selections: Selections; quantity: number }
  | { type: 'setQuantity'; id: string; quantity: number }
  | { type: 'remove'; id: string }
  | { type: 'clear' }
  | { type: 'attempt'; key: string };

export function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case 'add': {
      const id = lineId(action.product.id, action.selections);
      const existing = state.lines.find((l) => l.id === id);
      const quantity = Math.min(MAX_QUANTITY_PER_LINE, (existing?.quantity ?? 0) + Math.max(1, Math.floor(action.quantity)));
      const line: CartLine = {
        id, productId: action.product.id, name: action.product.name, kind: action.product.kind,
        unitCents: unitPrice(action.product, action.selections), quantity,
        selections: action.selections, summary: summarize(action.product, action.selections),
      };
      const lines = existing ? state.lines.map((l) => (l.id === id ? line : l)) : [...state.lines, line];
      return { lines, attemptKey: null };
    }
    case 'setQuantity': {
      const q = Math.min(MAX_QUANTITY_PER_LINE, Math.floor(action.quantity));
      const lines = q < 1 ? state.lines.filter((l) => l.id !== action.id) : state.lines.map((l) => (l.id === action.id ? { ...l, quantity: q } : l));
      return { lines, attemptKey: null };
    }
    case 'remove': return { lines: state.lines.filter((l) => l.id !== action.id), attemptKey: null };
    case 'clear': return EMPTY_CART;
    case 'attempt': return { ...state, attemptKey: action.key };
  }
}

export const lineTotal = (l: CartLine) => l.unitCents * l.quantity;
export const subtotal = (lines: readonly CartLine[]) => lines.reduce((s, l) => s + lineTotal(l), 0);
export const itemCount = (lines: readonly CartLine[]) => lines.reduce((s, l) => s + l.quantity, 0);

const asLimitLines = (lines: readonly CartLine[]) => lines.map((l) => ({ kind: l.kind, quantity: l.quantity, lineTotalCents: lineTotal(l) }));

export const cartViolations = (lines: readonly CartLine[], limits: OrderLimits): LimitViolation[] => orderLimitViolations(asLimitLines(lines), limits);

/** Cuánto del tope de cantidad se usó (0 a 1+), para mostrar una barra de uso. */
export function itemUsage(lines: readonly CartLine[], limits: OrderLimits): { used: number; limit: number } {
  const u = orderUsage(asLimitLines(lines), limits);
  return { used: u.equivalentItems, limit: limits.maxIndividualItems };
}

/** Cuerpo del pedido para la API. */
export function toOrderRequest(lines: readonly CartLine[], originLocationId: string | null, paymentMethod: OrderRequest['paymentMethod']): OrderRequest {
  return {
    paymentMethod,
    ...(originLocationId ? { originLocationId } : {}),
    items: lines.map((l) => ({ productId: l.productId, quantity: l.quantity, selections: Object.fromEntries(Object.entries(l.selections).filter(([, v]) => v.length > 0)) })),
  };
}
