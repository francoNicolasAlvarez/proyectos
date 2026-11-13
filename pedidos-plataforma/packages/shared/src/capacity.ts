/** Control de capacidad operativa: decide si el local puede recibir otro pedido ahora. */

export interface CapacityInput {
  paused: boolean;
  isOpen: boolean;
  activeOrders: number;               // aceptados, en preparación o listos (y pendientes de aceptación)
  ordersInCurrentInterval: number;
  maxConcurrentOrders?: number | null;
  maxOrdersPerInterval?: number | null;
}
export type CapacityDecision =
  | { ok: true }
  | { ok: false; reason: 'PAUSED' | 'CLOSED' | 'CONCURRENT_LIMIT' | 'INTERVAL_LIMIT' };

export function checkCapacity(i: CapacityInput): CapacityDecision {
  if (i.paused) return { ok: false, reason: 'PAUSED' };
  if (!i.isOpen) return { ok: false, reason: 'CLOSED' };
  if (i.maxConcurrentOrders != null && i.activeOrders >= i.maxConcurrentOrders) return { ok: false, reason: 'CONCURRENT_LIMIT' };
  if (i.maxOrdersPerInterval != null && i.ordersInCurrentInterval >= i.maxOrdersPerInterval) return { ok: false, reason: 'INTERVAL_LIMIT' };
  return { ok: true };
}

export interface HoursRule { weekday: number; opens: string; closes: string }   // "HH:MM"; closes < opens cruza la medianoche

const minutes = (hhmm: string): number => { const [h = '0', m = '0'] = hhmm.split(':'); return Number(h) * 60 + Number(m); };

/** ¿Está abierto en este instante? `weekday` 0=domingo y `minuteOfDay` en la hora local del local. */
export function isOpenAt(rules: readonly HoursRule[], weekday: number, minuteOfDay: number): boolean {
  if (rules.length === 0) return true;   // sin horarios configurados: sin restricción
  return rules.some((r) => {
    const o = minutes(r.opens), c = minutes(r.closes);
    if (c > o) return r.weekday === weekday && minuteOfDay >= o && minuteOfDay < c;
    // cruza la medianoche: la franja del día anterior sigue vigente hasta la hora de cierre
    return (r.weekday === weekday && minuteOfDay >= o) || ((r.weekday + 1) % 7 === weekday && minuteOfDay < c);
  });
}
