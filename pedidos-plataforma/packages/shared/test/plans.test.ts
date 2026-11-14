import { describe, expect, it } from 'vitest';
import { GRACE_DAYS, PLANS, TRIAL_DAYS, accessFor, canAdd, hasFeature, trialEnd, type Subscription } from '../src';

const DAY = 86_400_000;
const T0 = new Date('2026-03-01T12:00:00Z');
const after = (d: Date, days: number) => new Date(d.getTime() + days * DAY);

describe('topes por plan', () => {
  it('el plan gratuito permite hasta su tope y luego sugiere el plan siguiente', () => {
    expect(canAdd('free', 'maxStaff', 2)).toEqual({ ok: true });
    expect(canAdd('free', 'maxStaff', PLANS.free.maxStaff!)).toEqual({ ok: false, reason: 'PLAN_LIMIT', upgradeTo: 'basic' });
  });
  it('si el siguiente plan tampoco alcanza, sugiere el que sí (o ninguno)', () => {
    expect(canAdd('free', 'maxStaff', PLANS.basic.maxStaff!)).toEqual({ ok: false, reason: 'PLAN_LIMIT', upgradeTo: 'pro' });
    expect(canAdd('pro', 'maxStaff', 10_000)).toEqual({ ok: true });
  });
  it('un punto de retiro adicional exige mejorar el plan gratuito', () => {
    expect(canAdd('free', 'maxPickupPoints', 1)).toMatchObject({ ok: false, upgradeTo: 'basic' });
    expect(canAdd('basic', 'maxPickupPoints', 2)).toEqual({ ok: true });
  });
  it('funciones por plan: eventos solo en pro, promociones desde basic', () => {
    expect(hasFeature('free', 'events')).toEqual({ ok: false, reason: 'PLAN_FEATURE', upgradeTo: 'pro' });
    expect(hasFeature('basic', 'events')).toMatchObject({ ok: false });
    expect(hasFeature('pro', 'events')).toEqual({ ok: true });
    expect(hasFeature('free', 'promotions')).toMatchObject({ upgradeTo: 'basic' });
    expect(hasFeature('basic', 'promotions')).toEqual({ ok: true });
  });
  it('los planes son coherentes: cada plan superior incluye al inferior', () => {
    const num = (n: number | null) => (n === null ? Infinity : n);
    for (const [lo, hi] of [['free', 'basic'], ['basic', 'pro']] as const) {
      for (const k of ['maxStaff', 'maxPickupPoints', 'maxLocations'] as const) expect(num(PLANS[hi][k])).toBeGreaterThanOrEqual(num(PLANS[lo][k]));
      for (const k of ['events', 'promotions', 'customLimits'] as const) expect(Number(PLANS[hi][k])).toBeGreaterThanOrEqual(Number(PLANS[lo][k]));
    }
  });
});

describe('estado de la suscripción', () => {
  const trial = (extra: Partial<Subscription> = {}): Subscription => ({ plan: 'basic', status: 'trialing', trialEndsAt: trialEnd(T0), ...extra });

  it('la prueba dura 14 días y en los últimos 3 avisa', () => {
    expect(trialEnd(T0).getTime() - T0.getTime()).toBe(TRIAL_DAYS * DAY);
    expect(accessFor(trial(), after(T0, 1))).toMatchObject({ level: 'full', banner: 'none', daysLeft: 13 });
    expect(accessFor(trial(), after(T0, 12))).toMatchObject({ level: 'full', banner: 'trial_ending', daysLeft: 2 });
  });
  it('terminada la prueba sin pagar entra en gracia y luego queda en solo lectura', () => {
    const end = trialEnd(T0);
    expect(accessFor(trial(), after(end, 1))).toMatchObject({ level: 'grace', banner: 'payment_due', canReceiveOrders: true, effectiveStatus: 'past_due' });
    expect(accessFor(trial(), after(end, GRACE_DAYS + 1))).toMatchObject({ level: 'read_only', canReceiveOrders: false, canManage: false });
  });
  it('suscripción activa vigente: acceso completo; vencida: gracia y luego suspensión', () => {
    const sub: Subscription = { plan: 'pro', status: 'active', currentPeriodEnd: after(T0, 30) };
    expect(accessFor(sub, after(T0, 5))).toMatchObject({ level: 'full', daysLeft: 25 });
    expect(accessFor(sub, after(T0, 32))).toMatchObject({ level: 'grace', daysLeft: 3 });
    expect(accessFor(sub, after(T0, 36))).toMatchObject({ level: 'read_only', effectiveStatus: 'suspended' });
  });
  it('activa sin fecha de período (alta manual) no vence', () => {
    expect(accessFor({ plan: 'pro', status: 'active' }, after(T0, 999))).toMatchObject({ level: 'full', daysLeft: null });
  });
  it('past_due explícito respeta la gracia desde el fin del período', () => {
    const sub: Subscription = { plan: 'basic', status: 'past_due', currentPeriodEnd: T0 };
    expect(accessFor(sub, after(T0, 2)).level).toBe('grace');
    expect(accessFor(sub, after(T0, 6)).level).toBe('read_only');
  });
  it('suspendida y cancelada no reciben pedidos ni editan, pero SIEMPRE pueden atender lo ya pagado', () => {
    for (const status of ['suspended', 'canceled'] as const) {
      const a = accessFor({ plan: 'pro', status }, T0);
      expect(a).toMatchObject({ canReceiveOrders: false, canManage: false, canOperate: true });
    }
    expect(accessFor({ plan: 'pro', status: 'canceled' }, T0).level).toBe('blocked');
  });
  it('el plan gratuito no vence nunca, salvo cancelación o suspensión explícitas', () => {
    expect(accessFor({ plan: 'free', status: 'trialing', trialEndsAt: T0 }, after(T0, 500))).toMatchObject({ level: 'full', effectiveStatus: 'active' });
    expect(accessFor({ plan: 'free', status: 'suspended' }, T0).canReceiveOrders).toBe(false);
  });
  it('en ningún estado se corta la operación de pedidos ya tomados', () => {
    const statuses = ['trialing', 'active', 'past_due', 'suspended', 'canceled'] as const;
    for (const status of statuses) for (const d of [0, 10, 100]) {
      expect(accessFor({ plan: 'pro', status, trialEndsAt: T0, currentPeriodEnd: T0 }, after(T0, d)).canOperate).toBe(true);
    }
  });
});
