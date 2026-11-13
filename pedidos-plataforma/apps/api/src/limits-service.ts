/**
 * Configuración de los límites por pedido de cada local. Cada cambio queda auditado y reinicia el reloj de revisión
 * (los topes en pesos se desactualizan con la inflación). Además informa si los topes se pisan con los precios reales.
 */
import { checkLimitsConsistency, limitsReviewDue, type CatalogEntry, type LimitIssue } from '@pasamanos/shared';
import { DomainError, num, type Queryable } from './db';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface LimitsConfig {
  maxTotalCents: number; maxIndividualItems: number; maxCombos: number;
  /** Tope de gasto con pago al retiro (MVP 2). */
  maxTotalOnPickupCents: number;
  /** Minutos que un pedido sin pagar reserva cupo antes de cancelarse. */
  paymentWindowMinutes: number;
}
export interface LimitsReport { limits: LimitsConfig; reviewedAt: string; reviewDue: boolean; issues: LimitIssue[] }

const BOUNDS: Record<keyof LimitsConfig, [number, number]> = {
  maxTotalCents: [100, 1_000_000_000_000],        // desde $1 hasta $10.000.000.000
  maxIndividualItems: [1, 500],
  maxCombos: [1, 200],
  maxTotalOnPickupCents: [100, 1_000_000_000_000],
  paymentWindowMinutes: [1, 60],
};

const read = async (tx: Queryable, tenantId: string): Promise<Row> => {
  const s = (await tx.query<Row>('SELECT * FROM tenant_settings WHERE tenant_id = $1', [tenantId])).rows[0];
  if (!s) throw new DomainError('TENANT_NOT_CONFIGURED');
  return s;
};
const toConfig = (s: Row): LimitsConfig => ({
  maxTotalCents: num(s.max_order_total_cents), maxIndividualItems: num(s.max_individual_items), maxCombos: num(s.max_combos),
  maxTotalOnPickupCents: num(s.max_order_total_on_pickup_cents), paymentWindowMinutes: num(s.payment_window_minutes),
});

export async function getLimitsReport(tx: Queryable, tenantId: string, now: Date = new Date()): Promise<LimitsReport> {
  const s = await read(tx, tenantId);
  const products = (await tx.query<Row>('SELECT name, kind, base_price_cents FROM products WHERE tenant_id = $1 AND archived_at IS NULL AND available', [tenantId])).rows;
  const catalog: CatalogEntry[] = products.map((p) => ({ name: p.name, kind: p.kind === 'combo' ? 'combo' : 'simple', priceCents: num(p.base_price_cents) }));
  const limits = toConfig(s);
  const reviewedAt = new Date(s.limits_reviewed_at);
  return {
    limits, reviewedAt: reviewedAt.toISOString(), reviewDue: limitsReviewDue(reviewedAt, now),
    issues: checkLimitsConsistency({ maxTotalCents: limits.maxTotalCents, maxIndividualItems: limits.maxIndividualItems, maxCombos: limits.maxCombos }, catalog),
  };
}

export async function updateLimits(tx: Queryable, p: { tenantId: string; actorUserId: string; changes: Partial<LimitsConfig>; now?: Date }): Promise<LimitsReport> {
  const before = toConfig(await read(tx, p.tenantId));
  const next: LimitsConfig = { ...before };
  for (const key of Object.keys(p.changes) as (keyof LimitsConfig)[]) {
    const v = p.changes[key];
    if (v === undefined) continue;
    const [lo, hi] = BOUNDS[key] ?? [Number.NaN, Number.NaN];
    if (!Number.isInteger(v) || v < lo || v > hi) throw new DomainError('INVALID_LIMITS', `${key} fuera de rango`);
    next[key] = v;
  }
  await tx.query(
    `UPDATE tenant_settings SET max_order_total_cents=$2, max_individual_items=$3, max_combos=$4, max_order_total_on_pickup_cents=$5,
       payment_window_minutes=$6, limits_reviewed_at = now() WHERE tenant_id=$1`,
    [p.tenantId, next.maxTotalCents, next.maxIndividualItems, next.maxCombos, next.maxTotalOnPickupCents, next.paymentWindowMinutes]);
  await tx.query(
    "INSERT INTO audit_log (tenant_id, actor_user_id, action, entity, entity_id, before, after) VALUES ($1,$2,'limits.updated','tenant_settings',$5,$3,$4)",
    [p.tenantId, p.actorUserId, JSON.stringify(before), JSON.stringify(next), p.tenantId]);
  return getLimitsReport(tx, p.tenantId, p.now);
}

/** "Los límites siguen vigentes": reinicia el reloj de revisión sin cambiar valores. */
export async function confirmLimitsReviewed(tx: Queryable, p: { tenantId: string; actorUserId: string; now?: Date }): Promise<LimitsReport> {
  await read(tx, p.tenantId);
  await tx.query('UPDATE tenant_settings SET limits_reviewed_at = now() WHERE tenant_id = $1', [p.tenantId]);
  await tx.query("INSERT INTO audit_log (tenant_id, actor_user_id, action, entity, entity_id) VALUES ($1,$2,'limits.reviewed','tenant_settings',$3)", [p.tenantId, p.actorUserId, p.tenantId]);
  return getLimitsReport(tx, p.tenantId, p.now);
}
