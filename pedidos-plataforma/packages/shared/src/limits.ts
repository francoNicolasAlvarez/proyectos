/**
 * Límites por pedido: gasto máximo y cantidad (productos individuales u 8 combos), aplicados a la SUMA de los
 * pedidos abiertos de la persona en el local más el pedido nuevo (no solo al pedido nuevo), para que no se
 * puedan esquivar partiendo la compra en varios pedidos seguidos.
 *
 * "20 individuales u 8 combos" se aplica como equivalencia: un combo vale (maxIndividualItems / maxCombos)
 * productos individuales (2,5 con los valores por defecto), así que se pueden mezclar.
 */
import type { PaymentTiming } from './states';

export interface OrderLimits { maxTotalCents: number; maxIndividualItems: number; maxCombos: number }
export const DEFAULT_ORDER_LIMITS: OrderLimits = { maxTotalCents: 10_000_000, maxIndividualItems: 20, maxCombos: 8 };

/** Con pago al retiro el local prepara sin haber cobrado: tope de gasto menor por defecto ($30.000). */
export const DEFAULT_ON_PICKUP_MAX_TOTAL_CENTS = 3_000_000;

/** Los límites en pesos se desactualizan con la inflación: se pide revisarlos pasado este plazo. */
export const LIMITS_REVIEW_DAYS = 60;

export interface LimitSettings extends OrderLimits { maxTotalOnPickupCents?: number | null }

/** Límites efectivos según el momento de cobro: el pago al retiro nunca supera su tope propio. */
export function limitsFor(s: LimitSettings, timing: PaymentTiming): OrderLimits {
  const { maxTotalCents, maxIndividualItems, maxCombos } = s;
  if (timing === 'prepaid') return { maxTotalCents, maxIndividualItems, maxCombos };
  const cap = s.maxTotalOnPickupCents ?? DEFAULT_ON_PICKUP_MAX_TOTAL_CENTS;
  return { maxTotalCents: Math.min(maxTotalCents, cap), maxIndividualItems, maxCombos };
}

export type OrderLimitCode = 'ORDER_TOTAL_LIMIT_EXCEEDED' | 'ORDER_ITEM_LIMIT_EXCEEDED';
export interface LimitViolation {
  code: OrderLimitCode;
  /** Tope: centavos (gasto) o productos individuales equivalentes (cantidad). */
  limit: number;
  /** Valor total (pedido nuevo + pedidos abiertos) en la misma unidad que el tope. */
  actual: number;
  /** Parte de `actual` que ya corresponde a pedidos abiertos de la persona (se omite si no hay). */
  alreadyOpen?: number;
}
/** Consumo de los pedidos abiertos (sin entregar) de la persona en el local. */
export interface PriorUsage { individualItems: number; combos: number; totalCents: number }
export interface OrderUsage { individualItems: number; combos: number; equivalentItems: number; totalCents: number; openOrders?: PriorUsage }

type Line = { kind?: 'simple' | 'combo'; quantity: number; lineTotalCents: number };

const validate = (l: OrderLimits) => {
  if (l.maxCombos < 1 || l.maxIndividualItems < 1 || l.maxTotalCents < 1) throw new Error('Límites de pedido inválidos');
};
const equivalent = (individual: number, combos: number, l: OrderLimits) => individual + combos * (l.maxIndividualItems / l.maxCombos);

/** Consumo total: líneas del pedido nuevo más los pedidos abiertos de la persona. */
export function orderUsage(lines: readonly Line[], limits: OrderLimits = DEFAULT_ORDER_LIMITS, prior?: PriorUsage): OrderUsage {
  let individualItems = prior?.individualItems ?? 0; let combos = prior?.combos ?? 0; let totalCents = prior?.totalCents ?? 0;
  for (const l of lines) { if (l.kind === 'combo') combos += l.quantity; else individualItems += l.quantity; totalCents += l.lineTotalCents; }
  const u: OrderUsage = { individualItems, combos, equivalentItems: equivalent(individualItems, combos, limits), totalCents };
  if (prior && (prior.totalCents || prior.individualItems || prior.combos)) u.openOrders = prior;
  return u;
}

/** Todas las reglas que se incumplen (lista vacía si cumple). Aritmética entera para el tope de cantidad. */
export function orderLimitViolations(lines: readonly Line[], limits: OrderLimits = DEFAULT_ORDER_LIMITS, prior?: PriorUsage): LimitViolation[] {
  validate(limits);
  const u = orderUsage(lines, limits, prior);
  const out: LimitViolation[] = [];
  if (u.totalCents > limits.maxTotalCents) {
    out.push({ code: 'ORDER_TOTAL_LIMIT_EXCEEDED', limit: limits.maxTotalCents, actual: u.totalCents, ...(prior?.totalCents ? { alreadyOpen: prior.totalCents } : {}) });
  }
  // peso entero: individual = maxCombos, combo = maxIndividualItems; capacidad = maxIndividualItems × maxCombos
  if (u.individualItems * limits.maxCombos + u.combos * limits.maxIndividualItems > limits.maxIndividualItems * limits.maxCombos) {
    const priorEq = prior ? equivalent(prior.individualItems, prior.combos, limits) : 0;
    out.push({ code: 'ORDER_ITEM_LIMIT_EXCEEDED', limit: limits.maxIndividualItems, actual: u.equivalentItems, ...(priorEq ? { alreadyOpen: priorEq } : {}) });
  }
  return out;
}

export class OrderLimitError extends Error {
  readonly code: OrderLimitCode;
  constructor(readonly violations: readonly LimitViolation[], readonly usage: OrderUsage) {
    super(violations.map((v) => v.code).join(', '));
    this.name = 'OrderLimitError';
    this.code = (violations[0] as LimitViolation).code;
  }
}

/* ---------- Coherencia de los límites con el catálogo ---------- */

export interface CatalogEntry { name: string; kind: 'simple' | 'combo'; priceCents: number }
export type LimitIssueCode = 'PRODUCT_EXCEEDS_TOTAL' | 'COMBO_LIMIT_UNREACHABLE' | 'ITEM_LIMIT_UNREACHABLE';
export interface LimitIssue {
  code: LimitIssueCode;
  /** error: hay productos imposibles de comprar · warning: un tope no se puede alcanzar · info: el gasto manda sobre la cantidad. */
  severity: 'error' | 'warning' | 'info';
  product: string;
  /** Cuántas unidades de ese producto se pueden pedir de verdad antes de topar con el gasto. */
  maxReachable: number;
}

/**
 * Detecta límites que se pisan entre sí con los precios reales del local. Ejemplo: con tope de $100.000 y 8 combos,
 * un combo de $12.900 hace imposible llegar a 8 (el gasto salta en el 8.º). Devuelve la lista para avisar al local
 * al configurar los límites o cambiar precios.
 */
export function checkLimitsConsistency(limits: OrderLimits, catalog: readonly CatalogEntry[]): LimitIssue[] {
  validate(limits);
  const issues: LimitIssue[] = [];
  for (const p of catalog) {
    if (p.priceCents > limits.maxTotalCents) issues.push({ code: 'PRODUCT_EXCEEDS_TOTAL', severity: 'error', product: p.name, maxReachable: 0 });
  }
  for (const c of catalog.filter((p) => p.kind === 'combo' && p.priceCents > 0 && p.priceCents <= limits.maxTotalCents)) {
    if (c.priceCents * limits.maxCombos > limits.maxTotalCents) {
      issues.push({ code: 'COMBO_LIMIT_UNREACHABLE', severity: 'warning', product: c.name, maxReachable: Math.floor(limits.maxTotalCents / c.priceCents) });
    }
  }
  const simples = catalog.filter((p) => p.kind === 'simple' && p.priceCents > 0 && p.priceCents <= limits.maxTotalCents);
  const cheapest = simples.reduce<CatalogEntry | null>((m, p) => (!m || p.priceCents < m.priceCents ? p : m), null);
  if (cheapest && cheapest.priceCents * limits.maxIndividualItems > limits.maxTotalCents) {
    issues.push({ code: 'ITEM_LIMIT_UNREACHABLE', severity: 'info', product: cheapest.name, maxReachable: Math.floor(limits.maxTotalCents / cheapest.priceCents) });
  }
  return issues;
}

export const limitsReviewDue = (reviewedAt: Date, now: Date = new Date(), days: number = LIMITS_REVIEW_DAYS): boolean =>
  now.getTime() - reviewedAt.getTime() > days * 86_400_000;
