/**
 * Cálculo y validación de líneas de pedido. El servidor SIEMPRE recalcula: nunca se confía en precios del cliente.
 * Importes en centavos enteros.
 */

export interface OptionDef { id: string; name: string; priceDeltaCents: number; available: boolean }
export interface OptionGroupDef { id: string; name: string; minSelect: number; maxSelect: number; options: readonly OptionDef[] }
export interface ProductDef {
  id: string;
  name: string;
  basePriceCents: number;
  available: boolean;
  archived?: boolean;
  categoryPaused?: boolean;
  /** 'combo' cuenta como varios productos individuales en el límite de cantidad por pedido. */
  kind?: 'simple' | 'combo';
  prepMinutes: number;
  pickupPointId?: string | null;
  groups: readonly OptionGroupDef[];
}
export interface LineInput { productId: string; quantity: number; selections: Readonly<Record<string, readonly string[]>> }
export interface PricedLine {
  productId: string; quantity: number; unitPriceCents: number; lineTotalCents: number;
  chosen: { groupId: string; groupName: string; optionId: string; optionName: string; priceDeltaCents: number }[];
}

export type PricingErrorCode =
  | 'UNKNOWN_PRODUCT' | 'PRODUCT_UNAVAILABLE' | 'INVALID_QUANTITY' | 'UNKNOWN_GROUP'
  | 'UNKNOWN_OPTION' | 'OPTION_UNAVAILABLE' | 'DUPLICATE_OPTION' | 'SELECTION_BELOW_MIN' | 'SELECTION_ABOVE_MAX' | 'EMPTY_CART';

export class PricingError extends Error {
  constructor(readonly code: PricingErrorCode, readonly productId?: string, readonly groupId?: string) {
    super(`${code}${productId ? ` (producto ${productId}` : ''}${groupId ? `, grupo ${groupId}` : ''}${productId ? ')' : ''}`);
    this.name = 'PricingError';
  }
}

/* ---------- Límites por pedido ---------- */

/**
 * Límite de gasto y de cantidad por pedido. Valores por defecto: $100.000 y 20 productos individuales u 8 combos.
 * "20 individuales u 8 combos" se aplica como equivalencia: un combo vale (maxIndividualItems / maxCombos) productos
 * individuales (2,5 con los valores por defecto), así que se pueden mezclar sin superar el tope.
 */
export interface OrderLimits { maxTotalCents: number; maxIndividualItems: number; maxCombos: number }
export const DEFAULT_ORDER_LIMITS: OrderLimits = { maxTotalCents: 10_000_000, maxIndividualItems: 20, maxCombos: 8 };

export type OrderLimitCode = 'ORDER_TOTAL_LIMIT_EXCEEDED' | 'ORDER_ITEM_LIMIT_EXCEEDED';
export interface LimitViolation {
  code: OrderLimitCode;
  /** Tope: centavos (gasto) o productos individuales equivalentes (cantidad). */
  limit: number;
  /** Valor del pedido en la misma unidad que el tope. */
  actual: number;
}
export interface OrderUsage { individualItems: number; combos: number; equivalentItems: number; totalCents: number }

export class OrderLimitError extends Error {
  readonly code: OrderLimitCode;
  constructor(readonly violations: readonly LimitViolation[], readonly usage: OrderUsage) {
    super(violations.map((v) => v.code).join(', '));
    this.name = 'OrderLimitError';
    this.code = (violations[0] as LimitViolation).code;
  }
}

export function orderUsage(lines: readonly { kind?: 'simple' | 'combo'; quantity: number; lineTotalCents: number }[], limits: OrderLimits = DEFAULT_ORDER_LIMITS): OrderUsage {
  let individualItems = 0; let combos = 0; let totalCents = 0;
  for (const l of lines) { if (l.kind === 'combo') combos += l.quantity; else individualItems += l.quantity; totalCents += l.lineTotalCents; }
  return { individualItems, combos, equivalentItems: individualItems + combos * (limits.maxIndividualItems / limits.maxCombos), totalCents };
}

/** Todas las reglas que el pedido incumple (lista vacía si cumple). Aritmética entera para el tope de cantidad. */
export function orderLimitViolations(lines: readonly { kind?: 'simple' | 'combo'; quantity: number; lineTotalCents: number }[], limits: OrderLimits = DEFAULT_ORDER_LIMITS): LimitViolation[] {
  if (limits.maxCombos < 1 || limits.maxIndividualItems < 1 || limits.maxTotalCents < 1) throw new Error('Límites de pedido inválidos');
  const u = orderUsage(lines, limits);
  const out: LimitViolation[] = [];
  if (u.totalCents > limits.maxTotalCents) out.push({ code: 'ORDER_TOTAL_LIMIT_EXCEEDED', limit: limits.maxTotalCents, actual: u.totalCents });
  // peso entero: individual = maxCombos, combo = maxIndividualItems; capacidad = maxIndividualItems × maxCombos
  if (u.individualItems * limits.maxCombos + u.combos * limits.maxIndividualItems > limits.maxIndividualItems * limits.maxCombos) {
    out.push({ code: 'ORDER_ITEM_LIMIT_EXCEEDED', limit: limits.maxIndividualItems, actual: u.equivalentItems });
  }
  return out;
}

export const MAX_QUANTITY_PER_LINE = 50;

export function priceLine(product: ProductDef | undefined, line: LineInput): PricedLine {
  if (!product) throw new PricingError('UNKNOWN_PRODUCT', line.productId);
  if (!product.available || product.archived || product.categoryPaused) throw new PricingError('PRODUCT_UNAVAILABLE', product.id);
  if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > MAX_QUANTITY_PER_LINE) throw new PricingError('INVALID_QUANTITY', product.id);

  const known = new Set(product.groups.map((g) => g.id));
  for (const gid of Object.keys(line.selections)) if (!known.has(gid)) throw new PricingError('UNKNOWN_GROUP', product.id, gid);

  let unit = product.basePriceCents;
  const chosen: PricedLine['chosen'] = [];
  for (const g of product.groups) {
    const picked = line.selections[g.id] ?? [];
    if (new Set(picked).size !== picked.length) throw new PricingError('DUPLICATE_OPTION', product.id, g.id);
    if (picked.length < g.minSelect) throw new PricingError('SELECTION_BELOW_MIN', product.id, g.id);
    if (picked.length > g.maxSelect) throw new PricingError('SELECTION_ABOVE_MAX', product.id, g.id);
    for (const oid of picked) {
      const o = g.options.find((x) => x.id === oid);
      if (!o) throw new PricingError('UNKNOWN_OPTION', product.id, g.id);
      if (!o.available) throw new PricingError('OPTION_UNAVAILABLE', product.id, g.id);
      unit += o.priceDeltaCents;
      chosen.push({ groupId: g.id, groupName: g.name, optionId: o.id, optionName: o.name, priceDeltaCents: o.priceDeltaCents });
    }
  }
  return { productId: product.id, quantity: line.quantity, unitPriceCents: unit, lineTotalCents: unit * line.quantity, chosen };
}

export function priceCart(products: ReadonlyMap<string, ProductDef>, lines: readonly LineInput[], limits: OrderLimits = DEFAULT_ORDER_LIMITS) {
  if (lines.length === 0) throw new PricingError('EMPTY_CART');
  const priced = lines.map((l) => priceLine(products.get(l.productId), l));
  const forLimits = priced.map((l) => ({ kind: products.get(l.productId)?.kind, quantity: l.quantity, lineTotalCents: l.lineTotalCents }));
  const violations = orderLimitViolations(forLimits, limits);
  if (violations.length) throw new OrderLimitError(violations, orderUsage(forLimits, limits));
  return { lines: priced, subtotalCents: priced.reduce((a, l) => a + l.lineTotalCents, 0), usage: orderUsage(forLimits, limits) };
}

/** Tiempo estimado inicial: el mayor tiempo de preparación de los ítems (los productos se preparan en paralelo). */
export const estimatePrepMinutes = (products: readonly Pick<ProductDef, 'prepMinutes'>[]): number =>
  products.reduce((m, p) => Math.max(m, p.prepMinutes), 0);

/* ---------- División en partes de retiro ---------- */

export type PickupMode = 'single_point' | 'per_item';
export interface PartPlan<T> { pickupPointId: string | null; items: T[] }

/**
 * single_point: una sola parte; si el local tiene un único punto activo se asigna al crear,
 * y si tiene varios queda en null hasta que el empleado lo asigna al marcar listo (decisión D1).
 * per_item: una parte por punto resuelto (producto → categoría → punto por defecto).
 */
export function planParts<T extends { pickupPointId: string | null }>(
  items: readonly T[], mode: PickupMode, activePoints: readonly string[],
): PartPlan<T>[] {
  if (items.length === 0) return [];
  if (mode === 'single_point') {
    return [{ pickupPointId: activePoints.length === 1 ? (activePoints[0] ?? null) : null, items: [...items] }];
  }
  const groups = new Map<string | null, T[]>();
  for (const it of items) {
    const k = it.pickupPointId ?? null;
    groups.set(k, [...(groups.get(k) ?? []), it]);
  }
  return [...groups.entries()].map(([pickupPointId, its]) => ({ pickupPointId, items: its }));
}

/** Punto de retiro de un producto en modo per_item: producto → categoría → por defecto. */
export const resolvePickupPoint = (product: string | null | undefined, category: string | null | undefined, defaultPoint: string | null): string | null =>
  product ?? category ?? defaultPoint;
