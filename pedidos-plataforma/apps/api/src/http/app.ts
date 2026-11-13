/**
 * Capa HTTP (Fastify). Solo traduce: valida entrada con Zod, autentica por cookie de sesión, autoriza por rol
 * y delega en los servicios. Reglas de negocio y de aislamiento viven en los servicios y en la base de datos.
 */
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { CANCELLATION_REASONS, InvalidTransitionError, PricingError, can, type Action } from '@pasamanos/shared';
import { SESSION_DAYS, authenticate, login, logout, registerUser, roleIn, type AuthUser } from '../auth';
import { DomainError, withContext, type Database } from '../db';
import { resolveTenantBySlug } from '../menu';
import { listNotifications, markNotificationsRead } from '../notifications';
import { createOrder, markPartReady, redeemPickup, transitionOrder } from '../order-service';
import { handlePaymentWebhook } from '../payments/payment-service';
import type { PaymentProvider } from '../payments/provider';
import { getCustomerOrder, getPublicMenu, getVenueQueue } from '../read-models';

export interface AppConfig {
  db: Database;
  pickupSecret: string;
  webhookSecret: string;
  encryptionKey: Buffer;
  provider: PaymentProvider;
  /** Orígenes permitidos para peticiones con cookie (protección CSRF). */
  allowedOrigins: string[];
  secureCookies: boolean;
  /** Solo pruebas: rol de base de datos y costo de scrypt reducido. */
  dbRole?: string;
  scryptCost?: number;
}

const STATUS: Record<string, number> = {
  INVALID_CREDENTIALS: 401, INVALID_SIGNATURE: 401, UNAUTHENTICATED: 401,
  ACCOUNT_BLOCKED: 403, FORBIDDEN: 403, CSRF: 403,
  ORDER_NOT_FOUND: 404, PART_NOT_FOUND: 404, TENANT_NOT_FOUND: 404, TENANT_NOT_ACTIVE: 404, UNKNOWN_ACCOUNT: 404, NO_ACTIVE_MENU: 404,
  EMAIL_TAKEN: 409, ALREADY_USED: 409, IDEMPOTENCY_KEY_REUSED: 409, AMOUNT_MISMATCH: 409,
  PAUSED: 409, CLOSED: 409, CONCURRENT_LIMIT: 409, INTERVAL_LIMIT: 409, PRODUCT_NOT_IN_ACTIVE_MENU: 409,
  RATE_LIMITED: 429, IDEMPOTENCY_KEY_REQUIRED: 400,
};

const reasonCodes = Object.keys(CANCELLATION_REASONS) as [keyof typeof CANCELLATION_REASONS, ...(keyof typeof CANCELLATION_REASONS)[]];
const uuid = z.string().uuid();
const schemas = {
  register: z.object({ email: z.string().max(254), name: z.string().min(1).max(120), password: z.string().max(200), phone: z.string().max(40).nullish(), adultDeclared: z.boolean() }),
  login: z.object({ email: z.string().max(254), password: z.string().max(200) }),
  order: z.object({
    paymentMethod: z.enum(['card_online', 'payment_app']),
    originLocationId: uuid.nullish(),
    items: z.array(z.object({ productId: uuid, quantity: z.number().int(), selections: z.record(z.array(z.string().max(64)).max(20)).default({}) })).min(1).max(50),
  }),
  accept: z.object({ etaMinutes: z.number().int().min(1).max(240).optional() }).default({}),
  reject: z.object({ reasonCode: z.enum(reasonCodes), reasonText: z.string().max(300).optional() }),
  ready: z.object({ pickupPointId: uuid.optional() }).default({}),
  redeem: z.object({ token: z.string().max(200).optional(), shortCode: z.string().max(12).optional() }),
};

export async function buildApp(cfg: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 100_000 });
  await app.register(cookie);
  const role = cfg.dbRole;

  // Cuerpo JSON conservando el texto original (la firma del webhook se calcula sobre él).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
    try { done(null, body ? JSON.parse(body as string) : {}); } catch (e) { done(Object.assign(e as Error, { statusCode: 400 }), undefined); }
  });

  /* ---------- errores ---------- */
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ code: 'VALIDATION', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    if (err instanceof PricingError) return reply.code(422).send({ code: err.code, productId: err.productId ?? null });
    if (err instanceof InvalidTransitionError) return reply.code(409).send({ code: 'INVALID_TRANSITION' });
    if (err instanceof DomainError) return reply.code(STATUS[err.code] ?? 422).send({ code: err.code });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ code: 'BAD_REQUEST' });
    app.log.error(err);
    return reply.code(500).send({ code: 'INTERNAL' });   // sin detalles internos
  });

  /* ---------- CSRF: peticiones que cambian datos y llevan cookie deben venir de un origen permitido ---------- */
  app.addHook('preHandler', async (req) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.cookies.sid) return;
    const origin = req.headers.origin;
    if (!origin || !cfg.allowedOrigins.includes(origin)) throw new DomainError('CSRF');
  });

  /* ---------- limitación de intentos de login (en memoria; en producción, Redis) ---------- */
  const attempts = new Map<string, { n: number; until: number }>();
  const limited = (key: string) => { const a = attempts.get(key); return !!a && a.until > Date.now() && a.n >= 8; };
  const fail = (key: string) => { const a = attempts.get(key); attempts.set(key, a && a.until > Date.now() ? { n: a.n + 1, until: a.until } : { n: 1, until: Date.now() + 15 * 60_000 }); };

  /* ---------- helpers ---------- */
  const currentUser = async (req: FastifyRequest): Promise<AuthUser> => {
    const u = await withContext(cfg.db, { role }, (tx) => authenticate(tx, req.cookies.sid));
    if (!u) throw new DomainError('UNAUTHENTICATED');
    return u;
  };
  const tenantOf = async (slug: string) => {
    const t = await withContext(cfg.db, { role }, (tx) => resolveTenantBySlug(tx, slug));
    if (!t) throw new DomainError('TENANT_NOT_FOUND');
    return t;
  };
  /** Autoriza una acción de personal en el local indicado. El super admin actúa como propietario. */
  const staff = async (req: FastifyRequest, slug: string, action: Action) => {
    const user = await currentUser(req);
    const tenant = await tenantOf(slug);
    const r = user.isPlatformAdmin ? 'owner' : await withContext(cfg.db, { userId: user.id, role }, (tx) => roleIn(tx, user.id, tenant.id));
    if (!can(r, action)) throw new DomainError('FORBIDDEN');
    return { user, tenant, ctx: { tenantId: tenant.id, userId: user.id, role } };
  };
  const setSession = (reply: FastifyReply, token: string) =>
    reply.setCookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: cfg.secureCookies, path: '/', maxAge: SESSION_DAYS * 86_400 });
  const idParam = (req: FastifyRequest) => uuid.parse((req.params as { id: string }).id);

  /* ---------- cuenta ---------- */
  app.post('/auth/register', async (req, reply) => {
    const b = schemas.register.parse(req.body);
    const { userId } = await withContext(cfg.db, { role }, (tx) => registerUser(tx, { ...b, cost: cfg.scryptCost }));
    return reply.code(201).send({ id: userId });
  });

  app.post('/auth/login', async (req, reply) => {
    const b = schemas.login.parse(req.body);
    const key = `${req.ip}|${b.email.trim().toLowerCase()}`;
    if (limited(key)) throw new DomainError('RATE_LIMITED');
    try {
      const s = await withContext(cfg.db, { role }, (tx) => login(tx, { ...b, ip: req.ip, userAgent: req.headers['user-agent'], cost: cfg.scryptCost }));
      attempts.delete(key);
      setSession(reply, s.token);
      return { id: s.userId };
    } catch (e) { if (e instanceof DomainError && e.code === 'INVALID_CREDENTIALS') fail(key); throw e; }
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.cookies.sid) await withContext(cfg.db, { role }, (tx) => logout(tx, req.cookies.sid as string));
    return reply.clearCookie('sid', { path: '/' }).code(204).send();
  });

  app.get('/me', async (req) => currentUser(req));

  /* ---------- cliente ---------- */
  app.get('/venues/:slug/menu', async (req) => {
    const t = await tenantOf((req.params as { slug: string }).slug);
    return withContext(cfg.db, { tenantId: t.id, role }, (tx) => getPublicMenu(tx, t.id));
  });

  app.post('/venues/:slug/orders', async (req, reply) => {
    const user = await currentUser(req);
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 80) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED');
    const t = await tenantOf((req.params as { slug: string }).slug);
    const b = schemas.order.parse(req.body);
    const res = await withContext(cfg.db, { tenantId: t.id, userId: user.id, role }, (tx) =>
      createOrder(tx, { tenantId: t.id, userId: user.id, idempotencyKey: key, paymentMethod: b.paymentMethod, items: b.items, originLocationId: b.originLocationId }));
    return reply.code(res.replayed ? 200 : 201).send(res);
  });

  /** El pedido se ubica con el contexto del usuario y luego se lee con el del local: la propiedad se verifica siempre. */
  const ownOrderTenant = async (userId: string, orderId: string) => {
    const r = await withContext(cfg.db, { userId, role }, (tx) => tx.query<{ tenant_id: string }>('SELECT tenant_id FROM orders WHERE id=$1 AND user_id=$2', [orderId, userId]));
    if (!r.rows[0]) throw new DomainError('ORDER_NOT_FOUND');
    return r.rows[0].tenant_id;
  };

  app.get('/orders/:id', async (req) => {
    const user = await currentUser(req); const id = idParam(req);
    const tenantId = await ownOrderTenant(user.id, id);
    const view = await withContext(cfg.db, { tenantId, userId: user.id, role }, (tx) => getCustomerOrder(tx, { orderId: id, userId: user.id, secret: cfg.pickupSecret }));
    if (!view) throw new DomainError('ORDER_NOT_FOUND');
    return view;
  });

  app.post('/orders/:id/cancel', async (req) => {
    const user = await currentUser(req); const id = idParam(req);
    const tenantId = await ownOrderTenant(user.id, id);
    return withContext(cfg.db, { tenantId, userId: user.id, role }, (tx) => transitionOrder(tx, { tenantId, orderId: id, to: 'cancelled', actor: 'customer', actorUserId: user.id }));
  });

  app.get('/notifications', async (req) => {
    const user = await currentUser(req);
    return withContext(cfg.db, { userId: user.id, role }, (tx) => listNotifications(tx, user.id, { unreadOnly: (req.query as { unread?: string }).unread === '1' }));
  });
  app.post('/notifications/read', async (req) => {
    const user = await currentUser(req);
    const ids = z.object({ ids: z.array(uuid).max(200).optional() }).default({}).parse(req.body).ids;
    return { updated: await withContext(cfg.db, { userId: user.id, role }, (tx) => markNotificationsRead(tx, user.id, ids)) };
  });

  /* ---------- personal del local ---------- */
  app.get('/venues/:slug/staff/orders', async (req) => {
    const { tenant, ctx } = await staff(req, (req.params as { slug: string }).slug, 'orders.view');
    return withContext(cfg.db, ctx, (tx) => getVenueQueue(tx, tenant.id));
  });

  const move = (path: string, action: Action, to: 'accepted' | 'preparing', parse: (b: unknown) => { etaMinutes?: number }) =>
    app.post(`/venues/:slug/staff/orders/:id/${path}`, async (req) => {
      const { tenant, user, ctx } = await staff(req, (req.params as { slug: string }).slug, action);
      const b = parse(req.body);
      return withContext(cfg.db, ctx, (tx) => transitionOrder(tx, { tenantId: tenant.id, orderId: idParam(req), to, actor: 'staff', actorUserId: user.id, etaMinutes: b.etaMinutes }));
    });
  move('accept', 'orders.process', 'accepted', (b) => schemas.accept.parse(b));
  move('prepare', 'orders.process', 'preparing', () => ({}));

  app.post('/venues/:slug/staff/orders/:id/reject', async (req) => {
    const { tenant, user, ctx } = await staff(req, (req.params as { slug: string }).slug, 'orders.process');
    const b = schemas.reject.parse(req.body);
    return withContext(cfg.db, ctx, (tx) => transitionOrder(tx, { tenantId: tenant.id, orderId: idParam(req), to: 'rejected', actor: 'staff', actorUserId: user.id, reasonCode: b.reasonCode, reasonText: b.reasonText }));
  });

  app.post('/venues/:slug/staff/parts/:id/ready', async (req) => {
    const { tenant, user, ctx } = await staff(req, (req.params as { slug: string }).slug, 'orders.process');
    const b = schemas.ready.parse(req.body);
    const r = await withContext(cfg.db, ctx, (tx) => markPartReady(tx, { tenantId: tenant.id, partId: idParam(req), staffUserId: user.id, secret: cfg.pickupSecret, pickupPointId: b.pickupPointId }));
    return { orderReady: r.orderReady };   // el QR lo ve el cliente; el servidor no lo devuelve al personal
  });

  app.post('/venues/:slug/staff/pickup/redeem', async (req) => {
    const { tenant, user, ctx } = await staff(req, (req.params as { slug: string }).slug, 'orders.deliver');
    const b = schemas.redeem.parse(req.body);
    return withContext(cfg.db, ctx, (tx) => redeemPickup(tx, { tenantId: tenant.id, staffUserId: user.id, token: b.token, shortCode: b.shortCode }));
  });

  /* ---------- webhook del proveedor de pagos (sin cookie: se autentica por firma) ---------- */
  app.post('/webhooks/mercadopago', async (req, reply) => {
    const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
    const r = await handlePaymentWebhook(
      { db: cfg.db, provider: cfg.provider, webhookSecret: cfg.webhookSecret, encryptionKey: cfg.encryptionKey, role },
      { rawBody: raw, headers, query: req.query as Record<string, string | undefined> });
    return reply.code(200).send(r);   // 200 evita reintentos del proveedor; los errores reales devuelven 4xx/5xx
  });

  app.get('/health', async () => ({ ok: true }));
  return app;
}
