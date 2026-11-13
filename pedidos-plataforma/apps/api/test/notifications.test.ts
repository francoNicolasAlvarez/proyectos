import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { withContext, type Database, type RequestContext } from '../src/db';
import { dispatchOutbox, listNotifications, markNotificationsRead, notesFor, type Realtime } from '../src/notifications';
import { createOrder, markPartReady, markPaymentApproved, redeemPickup, transitionOrder } from '../src/order-service';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ROLE = 'app_runtime';
let pg: PGlite;
let db: Database;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync(fileURLToPath(new URL('../db/migrations/0001_init.sql', import.meta.url)), 'utf8'));
  db = pg as unknown as Database;
});
const one = async (sql: string, p: unknown[] = []) => (await pg.query<Row>(sql, p)).rows[0] as Row;

interface Seed { id: string; customer: string; staff: string; product: string }
let seq = 0;
async function seedTenant(): Promise<Seed> {
  const n = ++seq;
  const t = (await one("INSERT INTO tenants (name, slug) VALUES ($1,$2) RETURNING id", ['N' + n, 'notif-' + n])).id;
  const customer = (await one("INSERT INTO users (email, name) VALUES ($1,'C') RETURNING id", [`nc${n}@x.com`])).id;
  const staff = (await one("INSERT INTO users (email, name) VALUES ($1,'S') RETURNING id", [`ns${n}@x.com`])).id;
  await pg.query('INSERT INTO tenant_settings (tenant_id) VALUES ($1)', [t]);
  await pg.query("INSERT INTO tenant_payment_methods (tenant_id, method, enabled) VALUES ($1,'payment_app',true)", [t]);
  await pg.query("INSERT INTO pickup_points (tenant_id, name, is_default) VALUES ($1,'Barra 1',true)", [t]);
  const menu = (await one("INSERT INTO menus (tenant_id, name, is_default) VALUES ($1,'Carta',true) RETURNING id", [t])).id;
  const cat = (await one("INSERT INTO categories (tenant_id, menu_id, name) VALUES ($1,$2,'Todo') RETURNING id", [t, menu])).id;
  const product = (await one("INSERT INTO products (tenant_id, category_id, name, base_price_cents, prep_minutes) VALUES ($1,$2,'Papas',520000,12) RETURNING id", [t, cat])).id;
  return { id: t, customer, staff, product };
}
const ctx = (s: Seed, who: 'customer' | 'staff'): RequestContext => ({ tenantId: s.id, userId: who === 'customer' ? s.customer : s.staff, role: ROLE });
let k = 0;
const place = (s: Seed) => withContext(db, ctx(s, 'customer'), (tx) =>
  createOrder(tx, { tenantId: s.id, userId: s.customer, idempotencyKey: 'n' + ++k, paymentMethod: 'payment_app', items: [{ productId: s.product, quantity: 1, selections: {} }] }));
const pay = (s: Seed, o: { orderId: string; totalCents: number }) => withContext(db, { tenantId: s.id, role: ROLE }, (tx) =>
  markPaymentApproved(tx, { tenantId: s.id, orderId: o.orderId, provider: 'mp', providerPaymentId: 'NP' + ++k, amountCents: o.totalCents }));
const staffMove = (s: Seed, orderId: string, to: any, extra = {}) => withContext(db, ctx(s, 'staff'), (tx) => // eslint-disable-line @typescript-eslint/no-explicit-any
  transitionOrder(tx, { tenantId: s.id, orderId, to, actor: 'staff', actorUserId: s.staff, ...extra }));
const mine = (s: Seed) => withContext(db, { userId: s.customer, role: ROLE }, (tx) => listNotifications(tx, s.customer));

class Recorder implements Realtime {
  sent: { channel: string; message: Record<string, unknown> }[] = [];
  fail = false;
  publish(channel: string, message: Record<string, unknown>) { if (this.fail) throw new Error('SSE caído'); this.sent.push({ channel, message }); }
}

describe('textos', () => {
  it('formatean el número de pedido y los datos del hito', () => {
    expect(notesFor('order.accepted', { number: 7, etaMinutes: 12 })[0]?.body).toBe('El local aceptó tu pedido #007. Tiempo estimado: 12 min.');
    expect(notesFor('part.ready', { number: 7, point: 'Barra 2' })[0]?.body).toContain('en Barra 2');
    expect(notesFor('order.rejected', { number: 7, reason: 'Producto sin disponibilidad' })[0]?.body).toContain('Producto sin disponibilidad');
    expect(notesFor('order.created', { number: 1 })).toEqual([]);
    expect(notesFor('order.pending_acceptance', { number: 1 }).map((n) => n.type)).toEqual(['payment_approved', 'order_received']);
  });
});

describe('notificaciones del cliente', () => {
  it('recorren todos los hitos del pedido, en orden, hasta la entrega', async () => {
    const s = await seedTenant(); const rt = new Recorder();
    const o = await place(s);
    await pay(s, o);
    await staffMove(s, o.orderId, 'accepted', { etaMinutes: 14 });
    await staffMove(s, o.orderId, 'preparing');
    const partId = (await one('SELECT id FROM order_parts WHERE order_id=$1', [o.orderId])).id;
    const issued = await withContext(db, ctx(s, 'staff'), (tx) => markPartReady(tx, { tenantId: s.id, partId, staffUserId: s.staff, secret: 'x' }));
    await withContext(db, ctx(s, 'staff'), (tx) => redeemPickup(tx, { tenantId: s.id, staffUserId: s.staff, token: issued.token }));

    const res = await dispatchOutbox(db, rt, { role: ROLE });
    expect(res.notifications).toBe(6);
    const list = await mine(s);
    // la lista viene de la más nueva a la más vieja
    expect(list.map((n) => n.type).reverse()).toEqual(['payment_approved', 'order_received', 'order_accepted', 'order_preparing', 'order_ready', 'order_delivered']);
    expect(list.find((n) => n.type === 'order_ready')?.payload).toMatchObject({ number: 1, title: 'Listo para retirar' });
    expect(String((list.find((n) => n.type === 'order_ready')?.payload as Row).body)).toContain('Barra 1');
    expect(list.every((n) => !n.read)).toBe(true);
  });

  it('un rechazo de un pedido pagado avisa el motivo y el reembolso', async () => {
    const s = await seedTenant();
    const o = await place(s);
    await pay(s, o);
    await staffMove(s, o.orderId, 'rejected', { reasonCode: 'missing_ingredients' });
    await dispatchOutbox(db, null, { role: ROLE });
    const list = await mine(s);
    const types = list.map((n) => n.type);
    expect(types).toContain('order_rejected');
    expect(types).toContain('refund_started');
    expect(String((list.find((n) => n.type === 'order_rejected')?.payload as Row).body)).toContain('Falta de ingredientes');
  });

  it('no se procesa dos veces el mismo evento', async () => {
    const s = await seedTenant();
    await place(s);
    const first = await dispatchOutbox(db, null, { role: ROLE });
    expect(first.processed).toBeGreaterThan(0);
    expect(await dispatchOutbox(db, null, { role: ROLE })).toEqual({ processed: 0, notifications: 0 });
    expect(await one('SELECT count(*)::int n FROM outbox_events WHERE published_at IS NULL')).toMatchObject({ n: 0 });
  });

  it('cada cliente ve solo sus notificaciones y solo puede marcar como leídas las suyas', async () => {
    const a = await seedTenant(); const b = await seedTenant();
    const oa = await place(a); await pay(a, oa);
    const ob = await place(b); await pay(b, ob);
    await dispatchOutbox(db, null, { role: ROLE });
    const listA = await mine(a);
    expect(listA.length).toBe(2);
    expect(listA.every((n) => (n.payload as Row).orderId === oa.orderId)).toBe(true);

    // B intenta marcar las de A
    const hijack = await withContext(db, { userId: b.customer, role: ROLE }, (tx) => markNotificationsRead(tx, b.customer, listA.map((n) => n.id)));
    expect(hijack).toBe(0);
    expect((await mine(a)).every((n) => !n.read)).toBe(true);

    expect(await withContext(db, { userId: a.customer, role: ROLE }, (tx) => markNotificationsRead(tx, a.customer, [listA[0]!.id]))).toBe(1);
    const unread = await withContext(db, { userId: a.customer, role: ROLE }, (tx) => listNotifications(tx, a.customer, { unreadOnly: true }));
    expect(unread).toHaveLength(1);
    expect(await withContext(db, { userId: a.customer, role: ROLE }, (tx) => markNotificationsRead(tx, a.customer))).toBe(1);   // el resto
    expect(await withContext(db, { userId: a.customer, role: ROLE }, (tx) => markNotificationsRead(tx, a.customer, []))).toBe(0);
  });
});

describe('tiempo real', () => {
  it('avisa al cliente por su canal y al local por el canal del tenant', async () => {
    const s = await seedTenant(); const rt = new Recorder();
    const o = await place(s); await pay(s, o);
    await dispatchOutbox(db, rt, { role: ROLE });
    const channels = rt.sent.map((m) => m.channel);
    expect(channels).toContain(`user:${s.customer}`);
    expect(channels).toContain(`tenant:${s.id}`);
    expect(rt.sent.find((m) => m.channel === `tenant:${s.id}`)?.message).toMatchObject({ type: 'queue_changed', orderId: o.orderId });
    // el canal del local no lleva datos personales del cliente
    expect(JSON.stringify(rt.sent.filter((m) => m.channel.startsWith('tenant:')))).not.toContain(s.customer);
  });

  it('un fallo del canal en vivo no pierde las notificaciones guardadas', async () => {
    const s = await seedTenant(); const rt = new Recorder(); rt.fail = true;
    const o = await place(s); await pay(s, o);
    await expect(dispatchOutbox(db, rt, { role: ROLE })).resolves.toMatchObject({ notifications: 2 });
    expect((await mine(s)).length).toBe(2);
  });

  it('los eventos se publican en el orden en que ocurrieron', async () => {
    const s = await seedTenant(); const rt = new Recorder();
    const o = await place(s); await pay(s, o);
    await staffMove(s, o.orderId, 'accepted');
    await dispatchOutbox(db, rt, { role: ROLE });
    const userTypes = rt.sent.filter((m) => m.channel.startsWith('user:')).map((m) => m.message.type);
    expect(userTypes).toEqual(['payment_approved', 'order_received', 'order_accepted']);
  });
});
