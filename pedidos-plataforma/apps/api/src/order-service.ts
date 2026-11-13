/**
 * Servicio de pedidos: crear, confirmar pago, aceptar/rechazar/cancelar, preparar y retirar con QR.
 * Cada función recibe una transacción ya abierta con el contexto de RLS (ver withContext) y es atómica.
 * Las reglas de negocio puras viven en @pasamanos/shared; acá solo se orquestan con la base de datos.
 */
import {
  assertOperationalTransition, assertPartTransition, assertPaymentTransition, checkCapacity, deriveFromParts,
  estimatePrepMinutes, isOpenAt, limitsFor, planParts, priceCart, requiresRefund, resolvePickupPoint,
  type Actor, type CancellationReasonCode, type LineInput, type OperationalStatus, type OptionGroupDef, type ProductDef,
} from '@pasamanos/shared';
import { DomainError, num, type Queryable } from './db';
import { hashToken, makePickupToken, makeShortCode } from './pickup-token';
import { resolveActiveMenu } from './menu';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ONLINE_METHODS = ['card_online', 'payment_app'] as const;
export type OnlineMethod = (typeof ONLINE_METHODS)[number];

/* ---------- utilidades internas ---------- */
async function addHistory(tx: Queryable, h: {
  tenantId: string; orderId: string; partId?: string | null; axis: 'operational' | 'payment' | 'part';
  from: string | null; to: string; actor: Actor; actorUserId?: string | null; reason?: string | null;
}) {
  await tx.query(
    `INSERT INTO order_status_history (tenant_id, order_id, order_part_id, axis, from_status, to_status, actor_user_id, actor_kind, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [h.tenantId, h.orderId, h.partId ?? null, h.axis, h.from, h.to, h.actorUserId ?? null, h.actor, h.reason ?? null]);
}
const addOutbox = (tx: Queryable, tenantId: string, type: string, payload: object) =>
  tx.query('INSERT INTO outbox_events (tenant_id, type, payload) VALUES ($1,$2,$3)', [tenantId, type, JSON.stringify(payload)]);

async function lockOrder(tx: Queryable, tenantId: string, orderId: string): Promise<Row> {
  const o = (await tx.query<Row>('SELECT * FROM orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, orderId])).rows[0];
  if (!o) throw new DomainError('ORDER_NOT_FOUND');
  return o;
}

const placeholders = (from: number, n: number) => Array.from({ length: n }, (_, i) => `$${from + i}`).join(',');

/* ---------- crear pedido ---------- */
export interface CreateOrderInput {
  tenantId: string; userId: string; idempotencyKey: string; paymentMethod: OnlineMethod;
  items: LineInput[]; originLocationId?: string | null; now?: Date;
}
export interface CreatedOrder { orderId: string; orderNumber: number; totalCents: number; replayed: boolean }

export async function createOrder(tx: Queryable, input: CreateOrderInput): Promise<CreatedOrder> {
  const { tenantId, userId } = input;

  // 1. Idempotencia: el mismo intento (doble clic, reintento de red) devuelve el mismo pedido.
  const dup = (await tx.query<Row>('SELECT id, tenant_id, order_number, total_cents FROM orders WHERE user_id=$1 AND idempotency_key=$2', [userId, input.idempotencyKey])).rows[0];
  if (dup) {
    if (dup.tenant_id !== tenantId) throw new DomainError('IDEMPOTENCY_KEY_REUSED');
    return { orderId: dup.id, orderNumber: num(dup.order_number), totalCents: num(dup.total_cents), replayed: true };
  }

  if (!ONLINE_METHODS.includes(input.paymentMethod)) throw new DomainError('PAYMENT_METHOD_NOT_AVAILABLE');

  // 2. Local activo y configurado. El bloqueo de tenant_settings serializa la verificación de capacidad.
  const tenant = (await tx.query<Row>('SELECT status, timezone, currency FROM tenants WHERE id=$1', [tenantId])).rows[0];
  if (!tenant || tenant.status !== 'active') throw new DomainError('TENANT_NOT_ACTIVE');
  const settings = (await tx.query<Row>('SELECT * FROM tenant_settings WHERE tenant_id=$1 FOR UPDATE', [tenantId])).rows[0];
  if (!settings) throw new DomainError('TENANT_NOT_CONFIGURED');
  // Re-verificación de idempotencia ya con el bloqueo tomado: dos solicitudes simultáneas con la misma clave
  // pasan la primera verificación a la vez, pero acá se serializan y la segunda encuentra el pedido de la primera.
  const dup2 = (await tx.query<Row>('SELECT id, tenant_id, order_number, total_cents FROM orders WHERE user_id=$1 AND idempotency_key=$2', [userId, input.idempotencyKey])).rows[0];
  if (dup2) return { orderId: dup2.id, orderNumber: num(dup2.order_number), totalCents: num(dup2.total_cents), replayed: true };
  const method = await tx.query('SELECT 1 FROM tenant_payment_methods WHERE tenant_id=$1 AND method=$2 AND enabled', [tenantId, input.paymentMethod]);
  if (!method.rows.length) throw new DomainError('PAYMENT_METHOD_NOT_AVAILABLE');

  // 3. Horario y capacidad
  const clock = (await tx.query<Row>(
    `SELECT extract(dow FROM l)::int AS dow, (extract(hour FROM l) * 60 + extract(minute FROM l))::int AS minute_of_day, l::date::text AS local_date
     FROM (SELECT (COALESCE($2::timestamptz, now()) AT TIME ZONE $1) AS l) x`,
    [tenant.timezone, input.now?.toISOString() ?? null])).rows[0] as Row;
  const hours = (await tx.query<Row>('SELECT weekday, opens_at::text AS opens, closes_at::text AS closes FROM opening_hours WHERE tenant_id=$1', [tenantId])).rows;
  // Un pedido sin pagar RESERVA cupo mientras dura la ventana de pago (evita vender más de lo que se puede preparar
  // cuando muchos pedidos se crean antes de pagarse). Vencida la ventana, deja de contar y un job lo cancela.
  const active = num((await tx.query<Row>(
    `SELECT count(*)::int AS n FROM orders WHERE tenant_id=$1 AND (
       operational_status IN ('pending_acceptance','accepted','preparing','ready')
       OR (operational_status = 'awaiting_payment' AND placed_at > now() - make_interval(mins => $2::int)))`,
    [tenantId, settings.payment_window_minutes])).rows[0]?.n);
  const inInterval = settings.interval_minutes
    ? num((await tx.query<Row>(
      "SELECT count(*)::int AS n FROM orders WHERE tenant_id=$1 AND operational_status NOT IN ('cancelled','rejected') AND placed_at > now() - make_interval(mins => $2::int)",
      [tenantId, settings.interval_minutes])).rows[0]?.n) : 0;
  const cap = checkCapacity({
    paused: settings.ordering_paused, isOpen: isOpenAt(hours.map((h) => ({ weekday: num(h.weekday), opens: h.opens, closes: h.closes })), num(clock.dow), num(clock.minute_of_day)),
    activeOrders: active, ordersInCurrentInterval: inInterval,
    maxConcurrentOrders: settings.max_concurrent_orders, maxOrdersPerInterval: settings.max_orders_per_interval,
  });
  if (!cap.ok) throw new DomainError(cap.reason);

  // 4. El servidor recalcula todo desde el catálogo vigente (nunca confía en precios del cliente)
  const ids = [...new Set(input.items.map((i) => i.productId))];
  const prodRows = ids.length ? (await tx.query<Row>(
    `SELECT p.id, p.name, p.base_price_cents, p.available, p.archived_at, p.prep_minutes, p.pickup_point_id,
            c.paused AS category_paused, c.pickup_point_id AS category_point, c.menu_id, p.kind
     FROM products p JOIN categories c ON c.tenant_id = p.tenant_id AND c.id = p.category_id
     WHERE p.tenant_id=$1 AND p.id IN (${placeholders(2, ids.length)})`, [tenantId, ...ids])).rows : [];
  const optRows = ids.length ? (await tx.query<Row>(
    `SELECT g.id AS group_id, g.product_id, g.name AS group_name, g.min_select, g.max_select,
            o.id AS option_id, o.name AS option_name, o.price_delta_cents, o.available AS option_available
     FROM option_groups g LEFT JOIN options o ON o.tenant_id = g.tenant_id AND o.group_id = g.id
     WHERE g.tenant_id=$1 AND g.product_id IN (${placeholders(2, ids.length)})`, [tenantId, ...ids])).rows : [];

  const catalog = new Map<string, ProductDef>();
  const pickupByProduct = new Map<string, string | null>();
  for (const p of prodRows) {
    const groups = new Map<string, OptionGroupDef & { options: { id: string; name: string; priceDeltaCents: number; available: boolean }[] }>();
    for (const r of optRows.filter((x) => x.product_id === p.id)) {
      let g = groups.get(r.group_id);
      if (!g) { g = { id: r.group_id, name: r.group_name, minSelect: num(r.min_select), maxSelect: num(r.max_select), options: [] }; groups.set(r.group_id, g); }
      if (r.option_id) g.options.push({ id: r.option_id, name: r.option_name, priceDeltaCents: num(r.price_delta_cents), available: r.option_available });
    }
    catalog.set(p.id, {
      id: p.id, name: p.name, basePriceCents: num(p.base_price_cents), available: p.available, archived: p.archived_at != null,
      categoryPaused: p.category_paused, prepMinutes: num(p.prep_minutes), kind: p.kind === 'combo' ? 'combo' : 'simple', groups: [...groups.values()],
    });
    pickupByProduct.set(p.id, p.pickup_point_id ?? p.category_point ?? null);
  }
  // Solo se puede pedir del menú vigente (el de evento durante su ventana; el habitual el resto del tiempo).
  const activeMenu = await resolveActiveMenu(tx, tenantId, input.now);
  if (!activeMenu) throw new DomainError('NO_ACTIVE_MENU');
  if (prodRows.some((p) => p.menu_id !== activeMenu.menuId)) throw new DomainError('PRODUCT_NOT_IN_ACTIVE_MENU');
  // Límites por pedido (gasto y cantidad), propios de cada local; por defecto $100.000 y 20 productos u 8 combos.
  // El límite cuenta este pedido MÁS los pedidos abiertos de la misma persona en este local (no se esquiva partiendo la compra).
  const open = (await tx.query<Row>(
    `SELECT coalesce(sum(CASE WHEN i.kind_snapshot = 'combo' THEN 0 ELSE i.quantity END), 0)::int AS individual,
            coalesce(sum(CASE WHEN i.kind_snapshot = 'combo' THEN i.quantity ELSE 0 END), 0)::int AS combos,
            coalesce(sum(i.line_total_cents), 0)::text AS total
     FROM orders o JOIN order_items i ON i.tenant_id = o.tenant_id AND i.order_id = o.id
     WHERE o.tenant_id = $1 AND o.user_id = $2 AND (
       o.operational_status IN ('pending_acceptance','accepted','preparing','ready')
       OR (o.operational_status = 'awaiting_payment' AND o.placed_at > now() - make_interval(mins => $3::int)))`,
    [tenantId, userId, settings.payment_window_minutes])).rows[0] as Row;
  const cart = priceCart(catalog, input.items, limitsFor({
    maxTotalCents: num(settings.max_order_total_cents), maxIndividualItems: num(settings.max_individual_items), maxCombos: num(settings.max_combos),
    maxTotalOnPickupCents: num(settings.max_order_total_on_pickup_cents),
  }, 'prepaid'), { individualItems: num(open.individual), combos: num(open.combos), totalCents: num(open.total) });

  // 5. Origen informativo (nunca destino de entrega)
  let originName: string | null = null;
  if (input.originLocationId) {
    const loc = (await tx.query<Row>('SELECT name FROM locations WHERE tenant_id=$1 AND id=$2 AND active', [tenantId, input.originLocationId])).rows[0];
    if (!loc) throw new DomainError('INVALID_ORIGIN');
    originName = loc.name;
  }

  // 6. Partes de retiro según la modalidad del local
  const points = (await tx.query<Row>('SELECT id, is_default FROM pickup_points WHERE tenant_id=$1 AND active ORDER BY is_default DESC, sort_order, name', [tenantId])).rows;
  const defaultPoint = points.find((p) => p.is_default)?.id ?? null;
  const lines = cart.lines.map((l) => ({
    ...l, name: catalog.get(l.productId)?.name ?? '', prep: catalog.get(l.productId)?.prepMinutes ?? 0, kind: catalog.get(l.productId)?.kind ?? 'simple',
    pickupPointId: resolvePickupPoint(pickupByProduct.get(l.productId), null, defaultPoint),
  }));
  const plan = planParts(lines, settings.pickup_mode, points.map((p) => p.id));

  // 7. Persistir
  const eta = estimatePrepMinutes(cart.lines.map((l) => ({ prepMinutes: catalog.get(l.productId)?.prepMinutes ?? 0 })));
  const orderNumber = num((await tx.query<Row>('SELECT next_order_number($1, $2::date) AS n', [tenantId, clock.local_date])).rows[0]?.n);
  const order = (await tx.query<Row>(
    `INSERT INTO orders (tenant_id, user_id, order_number, counter_date, origin_location_id, origin_location_name_snapshot, event_id, operational_status,
       payment_timing, payment_method, payment_status, subtotal_cents, total_cents, currency, estimated_ready_at, idempotency_key)
     VALUES ($1,$2,$3,$4::date,$5,$6,$12,'awaiting_payment','prepaid',$7,'pending',$8,$8,$9, now() + make_interval(mins => $10::int), $11) RETURNING id`,
    [tenantId, userId, orderNumber, clock.local_date, input.originLocationId ?? null, originName, input.paymentMethod, cart.subtotalCents, tenant.currency, eta, input.idempotencyKey, activeMenu.eventId])).rows[0] as Row;

  for (const part of plan) {
    const partId = (await tx.query<Row>(
      "INSERT INTO order_parts (tenant_id, order_id, pickup_point_id, status) VALUES ($1,$2,$3,'pending') RETURNING id",
      [tenantId, order.id, part.pickupPointId])).rows[0]?.id;
    for (const l of part.items) {
      const itemId = (await tx.query<Row>(
        `INSERT INTO order_items (tenant_id, order_id, order_part_id, product_id, name_snapshot, kind_snapshot, unit_price_cents, quantity, line_total_cents, prep_minutes_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [tenantId, order.id, partId, l.productId, l.name, l.kind, l.unitPriceCents, l.quantity, l.lineTotalCents, l.prep])).rows[0]?.id;
      for (const c of l.chosen) {
        await tx.query(
          "INSERT INTO order_item_selections (tenant_id, order_item_id, kind, group_name_snapshot, name_snapshot, price_delta_cents) VALUES ($1,$2,'option',$3,$4,$5)",
          [tenantId, itemId, c.groupName, c.optionName, c.priceDeltaCents]);
      }
    }
  }
  await addHistory(tx, { tenantId, orderId: order.id, axis: 'operational', from: null, to: 'awaiting_payment', actor: 'customer', actorUserId: userId });
  await addOutbox(tx, tenantId, 'order.created', { orderId: order.id, orderNumber });
  return { orderId: order.id, orderNumber, totalCents: cart.subtotalCents, replayed: false };
}

/* ---------- transiciones operativas ---------- */
export interface TransitionInput {
  tenantId: string; orderId: string; to: OperationalStatus; actor: Actor; actorUserId?: string | null;
  reasonCode?: CancellationReasonCode; reasonText?: string; etaMinutes?: number;
}

export async function transitionOrder(tx: Queryable, p: TransitionInput): Promise<{ refundRequested: boolean }> {
  const o = await lockOrder(tx, p.tenantId, p.orderId);
  // Un cliente solo opera sobre SUS pedidos (RLS por sí sola no alcanza cuando el contexto incluye el local).
  if (p.actor === 'customer' && (!p.actorUserId || p.actorUserId !== o.user_id)) throw new DomainError('ORDER_NOT_FOUND');
  assertOperationalTransition(o.operational_status, p.to, p.actor);
  const closing = p.to === 'rejected' || p.to === 'cancelled';
  if (closing && p.actor !== 'customer' && !p.reasonCode) throw new DomainError('REASON_REQUIRED');

  await tx.query(
    `UPDATE orders SET operational_status = $3,
       accepted_at = CASE WHEN $3 = 'accepted' THEN now() ELSE accepted_at END,
       ready_at = CASE WHEN $3 = 'ready' THEN now() ELSE ready_at END,
       delivered_at = CASE WHEN $3 = 'delivered' THEN now() ELSE delivered_at END,
       cancelled_at = CASE WHEN $3 IN ('rejected','cancelled') THEN now() ELSE cancelled_at END,
       cancel_reason_code = COALESCE($4, cancel_reason_code),
       cancel_reason_text = COALESCE($5, cancel_reason_text),
       cancelled_by = CASE WHEN $3 IN ('rejected','cancelled') THEN $6 ELSE cancelled_by END,
       estimated_ready_at = CASE WHEN $7::int IS NULL THEN estimated_ready_at ELSE now() + make_interval(mins => $7::int) END
     WHERE tenant_id = $1 AND id = $2`,
    [p.tenantId, p.orderId, p.to, p.reasonCode ?? null, p.reasonText ?? null, p.actor === 'provider' ? 'system' : p.actor, p.etaMinutes ?? null]);

  if (p.to === 'preparing') await tx.query("UPDATE order_parts SET status='preparing' WHERE tenant_id=$1 AND order_id=$2 AND status='pending'", [p.tenantId, p.orderId]);
  if (closing) await tx.query("UPDATE order_parts SET status='cancelled' WHERE tenant_id=$1 AND order_id=$2 AND status IN ('pending','preparing')", [p.tenantId, p.orderId]);

  await addHistory(tx, { tenantId: p.tenantId, orderId: p.orderId, axis: 'operational', from: o.operational_status, to: p.to, actor: p.actor, actorUserId: p.actorUserId, reason: p.reasonCode ?? null });
  await addOutbox(tx, p.tenantId, `order.${p.to}`, { orderId: p.orderId, reasonCode: p.reasonCode ?? null });

  const refundRequested = requiresRefund({ paymentTiming: o.payment_timing, paymentStatus: o.payment_status }, p.to);
  if (refundRequested) await requestRefund(tx, p.tenantId, o, p.reasonCode ?? 'other', p.actor === 'staff' ? 'staff' : 'system', p.actorUserId);
  return { refundRequested };
}

/** Inicia el reembolso total del pago aprobado del pedido (lo ejecuta luego un worker con reintentos). */
async function requestRefund(tx: Queryable, tenantId: string, order: Row, reason: string, actor: Actor, actorUserId?: string | null) {
  const pay = (await tx.query<Row>("SELECT id, amount_cents FROM payments WHERE tenant_id=$1 AND order_id=$2 AND status='approved' ORDER BY created_at LIMIT 1", [tenantId, order.id])).rows[0];
  if (!pay) throw new DomainError('PAYMENT_NOT_FOUND');
  assertPaymentTransition('prepaid', 'approved', 'refund_pending', actor === 'staff' ? 'staff' : 'system');
  await tx.query("UPDATE payments SET status='refund_pending' WHERE tenant_id=$1 AND id=$2", [tenantId, pay.id]);
  await tx.query("UPDATE orders SET payment_status='refund_pending' WHERE tenant_id=$1 AND id=$2", [tenantId, order.id]);
  await tx.query('INSERT INTO refunds (tenant_id, payment_id, amount_cents, reason, requested_by) VALUES ($1,$2,$3,$4,$5)', [tenantId, pay.id, num(pay.amount_cents), reason, actorUserId ?? null]);
  await addHistory(tx, { tenantId, orderId: order.id, axis: 'payment', from: 'approved', to: 'refund_pending', actor, actorUserId, reason });
  await addOutbox(tx, tenantId, 'refund.requested', { orderId: order.id, paymentId: pay.id, amountCents: num(pay.amount_cents) });
}

/* ---------- confirmación de pago (webhook ya verificado contra la API del proveedor) ---------- */
export interface PaymentApprovedInput { tenantId: string; orderId: string; provider: string; providerPaymentId: string; amountCents: number }
export type PaymentResult = 'approved' | 'duplicate' | 'refunding_late_payment';

export async function markPaymentApproved(tx: Queryable, p: PaymentApprovedInput): Promise<PaymentResult> {
  const o = await lockOrder(tx, p.tenantId, p.orderId);
  const seen = await tx.query('SELECT 1 FROM payments WHERE provider=$1 AND provider_payment_id=$2', [p.provider, p.providerPaymentId]);
  if (seen.rows.length) return 'duplicate';   // webhook repetido: no se procesa dos veces
  if (o.payment_timing !== 'prepaid') throw new DomainError('PAYMENT_NOT_EXPECTED');
  if (p.amountCents !== num(o.total_cents)) throw new DomainError('AMOUNT_MISMATCH');

  // Pago que llega cuando el pedido ya no admite pago (vencido o rechazado): se registra y se reembolsa.
  if (o.payment_status !== 'pending') {
    const pay = (await tx.query<Row>(
      "INSERT INTO payments (tenant_id, order_id, provider, provider_payment_id, status, amount_cents, currency, approved_at) VALUES ($1,$2,$3,$4,'refund_pending',$5,$6, now()) RETURNING id",
      [p.tenantId, p.orderId, p.provider, p.providerPaymentId, p.amountCents, o.currency])).rows[0] as Row;
    await tx.query('INSERT INTO refunds (tenant_id, payment_id, amount_cents, reason) VALUES ($1,$2,$3,$4)', [p.tenantId, pay.id, p.amountCents, 'late_payment']);
    await addOutbox(tx, p.tenantId, 'refund.requested', { orderId: p.orderId, paymentId: pay.id, amountCents: p.amountCents });
    return 'refunding_late_payment';
  }

  assertPaymentTransition('prepaid', 'pending', 'approved', 'provider');
  await tx.query(
    "INSERT INTO payments (tenant_id, order_id, provider, provider_payment_id, status, amount_cents, currency, approved_at) VALUES ($1,$2,$3,$4,'approved',$5,$6, now())",
    [p.tenantId, p.orderId, p.provider, p.providerPaymentId, p.amountCents, o.currency]);
  await tx.query("UPDATE orders SET payment_status='approved' WHERE tenant_id=$1 AND id=$2", [p.tenantId, p.orderId]);
  await addHistory(tx, { tenantId: p.tenantId, orderId: p.orderId, axis: 'payment', from: 'pending', to: 'approved', actor: 'provider' });

  if (o.operational_status === 'awaiting_payment') {
    await transitionOrder(tx, { tenantId: p.tenantId, orderId: p.orderId, to: 'pending_acceptance', actor: 'provider' });
    const s = (await tx.query<Row>('SELECT acceptance_mode FROM tenant_settings WHERE tenant_id=$1', [p.tenantId])).rows[0];
    if (s?.acceptance_mode === 'auto') await transitionOrder(tx, { tenantId: p.tenantId, orderId: p.orderId, to: 'accepted', actor: 'system' });
  } else {
    // El cliente canceló mientras el pago estaba en curso: el dinero entró, así que se reembolsa.
    await requestRefund(tx, p.tenantId, { ...o, payment_status: 'approved' }, 'cancelled_before_payment', 'system');
    return 'refunding_late_payment';
  }
  return 'approved';
}

/* ---------- preparación y retiro ---------- */
export async function markPartReady(tx: Queryable, p: {
  tenantId: string; partId: string; staffUserId: string; secret: string; pickupPointId?: string | null;
}): Promise<{ token: string; shortCode: string; orderReady: boolean }> {
  const part = (await tx.query<Row>('SELECT * FROM order_parts WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [p.tenantId, p.partId])).rows[0];
  if (!part) throw new DomainError('PART_NOT_FOUND');
  const order = await lockOrder(tx, p.tenantId, part.order_id);
  assertPartTransition(part.status, 'ready', 'staff');

  // Decisión D1: si el local tiene varios puntos, el empleado asigna el punto al marcar listo.
  let pointId: string | null = part.pickup_point_id;
  if (!pointId) {
    if (!p.pickupPointId) throw new DomainError('PICKUP_POINT_REQUIRED');
    const ok = await tx.query('SELECT 1 FROM pickup_points WHERE tenant_id=$1 AND id=$2 AND active', [p.tenantId, p.pickupPointId]);
    if (!ok.rows.length) throw new DomainError('INVALID_PICKUP_POINT');
    pointId = p.pickupPointId;
  }
  await tx.query("UPDATE order_parts SET status='ready', ready_at=now(), pickup_point_id=$3 WHERE tenant_id=$1 AND id=$2", [p.tenantId, p.partId, pointId]);
  await addHistory(tx, { tenantId: p.tenantId, orderId: order.id, partId: p.partId, axis: 'part', from: part.status, to: 'ready', actor: 'staff', actorUserId: p.staffUserId });

  const token = makePickupToken(p.secret, p.tenantId, p.partId);
  let shortCode = '';
  for (let i = 0; i < 25 && !shortCode; i++) {
    const code = makeShortCode();
    const ins = await tx.query(
      'INSERT INTO pickup_tokens (tenant_id, order_part_id, token_hash, short_code) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id',
      [p.tenantId, p.partId, hashToken(token), code]);
    if (ins.rows.length) shortCode = code;
  }
  if (!shortCode) throw new DomainError('SHORT_CODE_EXHAUSTED');

  const statuses = (await tx.query<Row>('SELECT status FROM order_parts WHERE tenant_id=$1 AND order_id=$2', [p.tenantId, order.id])).rows.map((r) => r.status);
  const orderReady = deriveFromParts(statuses) === 'ready' && order.operational_status === 'preparing';
  if (orderReady) await transitionOrder(tx, { tenantId: p.tenantId, orderId: order.id, to: 'ready', actor: 'staff', actorUserId: p.staffUserId });
  await addOutbox(tx, p.tenantId, 'part.ready', { orderId: order.id, partId: p.partId, pickupPointId: pointId });
  return { token, shortCode, orderReady };
}

/** Datos para que el cliente muestre su QR (se recalcula; el servidor no guarda el token en claro).
 *  IMPORTANTE: el llamador debe haber verificado antes que la parte pertenece al cliente (ver getCustomerOrder). */
export async function getPickupCredentials(tx: Queryable, p: { tenantId: string; partId: string; secret: string }) {
  const t = (await tx.query<Row>('SELECT short_code, used_at FROM pickup_tokens WHERE order_part_id=$1 ORDER BY created_at DESC LIMIT 1', [p.partId])).rows[0];
  if (!t) return null;
  return { token: makePickupToken(p.secret, p.tenantId, p.partId), shortCode: t.short_code as string, used: t.used_at != null };
}

export async function redeemPickup(tx: Queryable, p: {
  tenantId: string; staffUserId: string; token?: string; shortCode?: string;
}): Promise<{ orderId: string; orderNumber: number; partId: string; orderDelivered: boolean }> {
  if (!p.token && !p.shortCode) throw new DomainError('INVALID_CODE');
  const where = p.token ? 'token_hash = $2' : 'short_code = $2';
  const value = p.token ? hashToken(p.token) : (p.shortCode ?? '').trim().toUpperCase();

  // Consumo atómico: de dos escaneos simultáneos, solo uno obtiene la fila.
  const used = await tx.query<Row>(
    `UPDATE pickup_tokens SET used_at = now(), used_by = $3
     WHERE tenant_id = $1 AND ${where} AND used_at IS NULL AND (expires_at IS NULL OR expires_at > now()) RETURNING order_part_id`,
    [p.tenantId, value, p.staffUserId]);
  const row = used.rows[0];
  if (!row) {
    const exists = await tx.query(`SELECT 1 FROM pickup_tokens WHERE tenant_id = $1 AND ${where}`, [p.tenantId, value]);
    throw new DomainError(exists.rows.length ? 'ALREADY_USED' : 'INVALID_CODE');
  }

  const part = (await tx.query<Row>('SELECT * FROM order_parts WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [p.tenantId, row.order_part_id])).rows[0] as Row;
  const order = await lockOrder(tx, p.tenantId, part.order_id);
  assertPartTransition(part.status, 'delivered', 'staff');   // si falla, la transacción entera se revierte
  await tx.query("UPDATE order_parts SET status='delivered', delivered_at=now(), delivered_by=$3 WHERE tenant_id=$1 AND id=$2", [p.tenantId, part.id, p.staffUserId]);
  await addHistory(tx, { tenantId: p.tenantId, orderId: order.id, partId: part.id, axis: 'part', from: part.status, to: 'delivered', actor: 'staff', actorUserId: p.staffUserId });

  const statuses = (await tx.query<Row>('SELECT status FROM order_parts WHERE tenant_id=$1 AND order_id=$2', [p.tenantId, order.id])).rows.map((r) => r.status);
  const orderDelivered = deriveFromParts(statuses) === 'delivered';
  if (orderDelivered) await transitionOrder(tx, { tenantId: p.tenantId, orderId: order.id, to: 'delivered', actor: 'staff', actorUserId: p.staffUserId });
  return { orderId: order.id, orderNumber: num(order.order_number), partId: part.id, orderDelivered };
}
