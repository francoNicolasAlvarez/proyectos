/**
 * Máquinas de estado del pedido (ADR 0004). Estados financieros y operativos separados.
 * Funciones puras: la API las usa dentro de una transacción y escribe order_status_history.
 */

export type Actor = 'customer' | 'staff' | 'system' | 'provider';

export type OperationalStatus =
  | 'awaiting_payment' | 'pending_acceptance' | 'accepted' | 'preparing' | 'ready'
  | 'delivered' | 'rejected' | 'cancelled' | 'not_picked_up';

export type PaymentTiming = 'prepaid' | 'on_pickup';

export type PaymentStatus =
  | 'pending' | 'approved' | 'rejected' | 'expired' | 'refund_pending' | 'refunded' | 'partially_refunded'
  | 'pending_collection' | 'collected_on_pickup' | 'not_collected';

export type PartStatus = 'pending' | 'preparing' | 'ready' | 'delivered' | 'not_picked_up' | 'cancelled';

type Rule<S extends string> = Partial<Record<S, readonly Actor[]>>;
type Table<S extends string> = Record<S, Rule<S>>;

export const OPERATIONAL: Table<OperationalStatus> = {
  awaiting_payment: { pending_acceptance: ['provider', 'system'], cancelled: ['customer', 'system'] },
  pending_acceptance: { accepted: ['staff', 'system'], rejected: ['staff', 'system'], cancelled: ['customer', 'staff', 'system'] },
  accepted: { preparing: ['staff'], cancelled: ['staff'] },
  preparing: { ready: ['staff', 'system'], cancelled: ['staff'] },
  ready: { delivered: ['staff'], not_picked_up: ['staff', 'system'] },
  delivered: {}, rejected: {}, cancelled: {}, not_picked_up: {},
};

/** Pago anticipado: lo mueve el proveedor (webhook) o el sistema; el reembolso lo inicia el sistema o el personal. */
const PREPAID: Table<PaymentStatus> = {
  pending: { approved: ['provider', 'system'], rejected: ['provider', 'system'], expired: ['system'] },
  approved: { refund_pending: ['system', 'staff'] },
  refund_pending: { refunded: ['provider', 'system'], partially_refunded: ['provider', 'system'] },
  partially_refunded: { refund_pending: ['system', 'staff'] },
  rejected: {}, expired: {}, refunded: {},
  pending_collection: {}, collected_on_pickup: {}, not_collected: {},
};

/** Pago al retiro: lo confirma el empleado al entregar. */
const ON_PICKUP: Table<PaymentStatus> = {
  pending_collection: { collected_on_pickup: ['staff'], not_collected: ['staff', 'system'] },
  collected_on_pickup: {}, not_collected: {},
  pending: {}, approved: {}, rejected: {}, expired: {}, refund_pending: {}, refunded: {}, partially_refunded: {},
};

export const PART: Table<PartStatus> = {
  pending: { preparing: ['staff', 'system'], cancelled: ['staff', 'system', 'customer'] },
  preparing: { ready: ['staff'], cancelled: ['staff', 'system'] },
  ready: { delivered: ['staff'], not_picked_up: ['staff', 'system'] },
  delivered: {}, not_picked_up: {}, cancelled: {},
};

export class InvalidTransitionError extends Error {
  constructor(readonly axis: string, readonly from: string, readonly to: string, readonly actor: Actor, detail: string) {
    super(`Transición inválida (${axis}): ${from} → ${to} por ${actor}. ${detail}`);
    this.name = 'InvalidTransitionError';
  }
}

function check<S extends string>(axis: string, table: Table<S>, from: S, to: S, actor: Actor): void {
  const allowed = table[from]?.[to];
  if (!allowed) throw new InvalidTransitionError(axis, from, to, actor, 'La transición no existe.');
  if (!allowed.includes(actor)) throw new InvalidTransitionError(axis, from, to, actor, `Solo pueden: ${allowed.join(', ')}.`);
}

export const assertOperationalTransition = (from: OperationalStatus, to: OperationalStatus, actor: Actor) =>
  check('operational', OPERATIONAL, from, to, actor);

export const assertPaymentTransition = (timing: PaymentTiming, from: PaymentStatus, to: PaymentStatus, actor: Actor) =>
  check('payment', timing === 'prepaid' ? PREPAID : ON_PICKUP, from, to, actor);

export const assertPartTransition = (from: PartStatus, to: PartStatus, actor: Actor) => check('part', PART, from, to, actor);

export const isTerminal = (s: OperationalStatus): boolean => Object.keys(OPERATIONAL[s]).length === 0;

/** El pedido es visible para el local solo cuando ya salió de awaiting_payment. */
export const isVisibleToVenue = (s: OperationalStatus): boolean => s !== 'awaiting_payment';

/**
 * Estado operativo derivado de las partes (cuando el pedido ya fue aceptado).
 * - todas entregadas → delivered; todas entregadas o no retiradas, con alguna no retirada → not_picked_up
 * - ninguna pendiente o en preparación, y al menos una lista → ready
 * - alguna en preparación (o pendiente con otras avanzadas) → preparing
 * Devuelve null si no hay partes activas que permitan derivar un estado.
 */
export function deriveFromParts(parts: readonly PartStatus[]): 'preparing' | 'ready' | 'delivered' | 'not_picked_up' | 'cancelled' | null {
  if (parts.length === 0) return null;
  const active = parts.filter((p) => p !== 'cancelled');
  if (active.length === 0) return 'cancelled';
  if (active.every((p) => p === 'delivered')) return 'delivered';
  if (active.every((p) => p === 'delivered' || p === 'not_picked_up')) return 'not_picked_up';
  if (active.some((p) => p === 'pending' || p === 'preparing')) return active.some((p) => p === 'preparing' || p === 'ready' || p === 'delivered') ? 'preparing' : null;
  return 'ready'; // solo listas, entregadas o no retiradas, con al menos una lista
}

/** Un pedido prepago ya cobrado que se rechaza o cancela exige reembolso. */
export function requiresRefund(order: { paymentTiming: PaymentTiming; paymentStatus: PaymentStatus }, to: OperationalStatus): boolean {
  return order.paymentTiming === 'prepaid' && order.paymentStatus === 'approved' && (to === 'rejected' || to === 'cancelled');
}

/** Motivos predefinidos de rechazo o cancelación (códigos de cancellation_reasons). */
export const CANCELLATION_REASONS = {
  out_of_stock: 'Producto sin disponibilidad',
  missing_ingredients: 'Falta de ingredientes',
  capacity_exceeded: 'Capacidad operativa excedida',
  venue_closed: 'Establecimiento temporalmente cerrado',
  technical_issue: 'Problemas técnicos',
  other: 'Otro motivo',
} as const;
export type CancellationReasonCode = keyof typeof CANCELLATION_REASONS;
