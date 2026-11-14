/**
 * Planes y suscripción de un local (lógica de ventas, pura y sin dependencias).
 *
 * IMPORTANTE: los planes y topes de abajo son una PROPUESTA sin validar con clientes reales.
 * Los precios no están acá a propósito: se deciden en el área comercial (ver docs/negocio/).
 * Este módulo solo define cómo se comporta el sistema según el plan y el estado de la suscripción.
 */

export type PlanId = 'free' | 'basic' | 'pro';

export interface PlanFeatures {
  maxStaff: number | null;            // null = sin tope
  maxPickupPoints: number | null;
  maxLocations: number | null;        // sectores con QR
  events: boolean;                    // menús de evento
  promotions: boolean;
  reports: 'none' | 'basic' | 'advanced';
  customLimits: boolean;              // editar topes por pedido
}

export const PLANS: Readonly<Record<PlanId, PlanFeatures>> = {
  free:  { maxStaff: 3,    maxPickupPoints: 1,    maxLocations: 10,   events: false, promotions: false, reports: 'none',     customLimits: false },
  basic: { maxStaff: 10,   maxPickupPoints: 3,    maxLocations: 50,   events: false, promotions: true,  reports: 'basic',    customLimits: true },
  pro:   { maxStaff: null, maxPickupPoints: null, maxLocations: null, events: true,  promotions: true,  reports: 'advanced', customLimits: true },
};

export type FeatureCheck = { ok: true } | { ok: false; reason: 'PLAN_LIMIT' | 'PLAN_FEATURE'; upgradeTo: PlanId | null };

const ORDER: readonly PlanId[] = ['free', 'basic', 'pro'];
/** Menor plan que cumple la condición, para sugerir la mejora. */
const cheapestThat = (ok: (f: PlanFeatures) => boolean): PlanId | null => ORDER.find((p) => ok(PLANS[p])) ?? null;

type CountedLimit = 'maxStaff' | 'maxPickupPoints' | 'maxLocations';

/** ¿Puede el local sumar uno más? `current` es la cantidad actual (activos). */
export function canAdd(plan: PlanId, what: CountedLimit, current: number): FeatureCheck {
  const max = PLANS[plan][what];
  if (max === null || current < max) return { ok: true };
  return { ok: false, reason: 'PLAN_LIMIT', upgradeTo: cheapestThat((f) => f[what] === null || (f[what] as number) > current) };
}

export function hasFeature(plan: PlanId, feature: 'events' | 'promotions' | 'customLimits'): FeatureCheck {
  if (PLANS[plan][feature]) return { ok: true };
  return { ok: false, reason: 'PLAN_FEATURE', upgradeTo: cheapestThat((f) => f[feature]) };
}

/* ---------------- Estado de la suscripción ---------------- */

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'suspended' | 'canceled';

export interface Subscription {
  plan: PlanId;
  status: SubscriptionStatus;
  trialEndsAt?: Date | null;
  /** Fin del período pagado; pasado este instante sin renovar empieza la gracia. */
  currentPeriodEnd?: Date | null;
  canceledAt?: Date | null;
}

export const TRIAL_DAYS = 14;
export const GRACE_DAYS = 5;
const DAY = 86_400_000;

export type AccessLevel = 'full' | 'grace' | 'read_only' | 'blocked';

export interface Access {
  level: AccessLevel;
  canReceiveOrders: boolean;   // los clientes pueden pedir
  canManage: boolean;          // el personal puede editar catálogo y configuración
  canOperate: boolean;         // el personal sigue atendiendo pedidos ya tomados (nunca se corta: hay plata de clientes en juego)
  banner: 'none' | 'trial_ending' | 'payment_due' | 'suspended' | 'canceled';
  daysLeft: number | null;
  effectiveStatus: SubscriptionStatus;
}

/**
 * Qué puede hacer el local según su suscripción, en el instante `now`.
 * Regla de producto: nunca se bloquea la atención de pedidos ya pagados, aunque falle el cobro de la suscripción.
 * El plan gratuito no vence.
 */
export function accessFor(sub: Subscription, now: Date): Access {
  const t = now.getTime();
  const full = (banner: Access['banner'] = 'none', daysLeft: number | null = null, s: SubscriptionStatus = sub.status): Access =>
    ({ level: 'full', canReceiveOrders: true, canManage: true, canOperate: true, banner, daysLeft, effectiveStatus: s });

  if (sub.plan === 'free' && sub.status !== 'canceled' && sub.status !== 'suspended') return full('none', null, 'active');

  switch (sub.status) {
    case 'trialing': {
      if (!sub.trialEndsAt) return full('none', null);
      const left = Math.ceil((sub.trialEndsAt.getTime() - t) / DAY);
      if (left > 0) return full(left <= 3 ? 'trial_ending' : 'none', left);
      // La prueba terminó sin pasar a pago: se trata como pago vencido con su gracia.
      return pastDue(sub.trialEndsAt.getTime(), t);
    }
    case 'active': {
      if (!sub.currentPeriodEnd || sub.currentPeriodEnd.getTime() > t) {
        const left = sub.currentPeriodEnd ? Math.ceil((sub.currentPeriodEnd.getTime() - t) / DAY) : null;
        return full('none', left);
      }
      return pastDue(sub.currentPeriodEnd.getTime(), t);
    }
    case 'past_due':
      return pastDue(sub.currentPeriodEnd?.getTime() ?? t, t);
    case 'suspended':
      return { level: 'read_only', canReceiveOrders: false, canManage: false, canOperate: true, banner: 'suspended', daysLeft: null, effectiveStatus: 'suspended' };
    case 'canceled':
      return { level: 'blocked', canReceiveOrders: false, canManage: false, canOperate: true, banner: 'canceled', daysLeft: null, effectiveStatus: 'canceled' };
  }
}

function pastDue(dueAt: number, now: number): Access {
  const graceLeft = Math.ceil((dueAt + GRACE_DAYS * DAY - now) / DAY);
  if (graceLeft > 0) {
    return { level: 'grace', canReceiveOrders: true, canManage: true, canOperate: true, banner: 'payment_due', daysLeft: graceLeft, effectiveStatus: 'past_due' };
  }
  return { level: 'read_only', canReceiveOrders: false, canManage: false, canOperate: true, banner: 'suspended', daysLeft: 0, effectiveStatus: 'suspended' };
}

/** Fecha de fin de prueba para una alta en `from`. */
export const trialEnd = (from: Date, days = TRIAL_DAYS): Date => new Date(from.getTime() + days * DAY);
