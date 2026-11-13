/**
 * Cálculo y validación de líneas de pedido. El servidor SIEMPRE recalcula: nunca se confía en precios del cliente.
 * Importes en centavos enteros.
 */

export interface OptionDef { id: string; priceDeltaCents: number; available: boolean }
export interface OptionGroupDef { id: string; name: string; minSelect: number; maxSelect: number; options: readonly OptionDef[] }
export interface ProductDef {
  id: string;
  name: string;
  basePriceCents: number;
  available: boolean;
  archived?: boolean;
  categoryPaused?: boolean;
  prepMinutes: number;
  pickupPointId?: string | null;
  groups: readonly OptionGroupDef[];
}
export interface LineInput { productId: string; quantity: number; selections: Readonly<Record<string, readonly string[]>> }
export interface PricedLine {
  productId: string; quantity: number; unitPriceCents: number; lineTotalCents: number;
  chosen: { groupId: string; groupName: string; optionId: string; priceDeltaCents: number }[];
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
      chosen.push({ groupId: g.id, groupName: g.name, optionId: o.id, priceDeltaCents: o.priceDeltaCents });
    }
  }
  return { productId: product.id, quantity: line.quantity, unitPriceCents: unit, lineTotalCents: unit * line.quantity, chosen };
}

export function priceCart(products: ReadonlyMap<string, ProductDef>, lines: readonly LineInput[]) {
  if (lines.length === 0) throw new PricingError('EMPTY_CART');
  const priced = lines.map((l) => priceLine(products.get(l.productId), l));
  return { lines: priced, subtotalCents: priced.reduce((a, l) => a + l.lineTotalCents, 0) };
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
