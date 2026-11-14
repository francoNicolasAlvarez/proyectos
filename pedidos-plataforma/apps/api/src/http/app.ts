/**
 * Capa HTTP (Fastify). Solo traduce: valida entrada con Zod, autentica por cookie de sesión, autoriza por rol
 * y delega en los servicios. Reglas de negocio y de aislamiento viven en los servicios y en la base de datos.
 */
import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { CANCELLATION_REASONS, InvalidTransitionError, OrderLimitError, PricingError, can, type Action } from '@pasamanos/shared';
import { SESSION_DAYS, authenticate, login, logout, registerUser, roleIn, type AuthUser } from '../auth';
import { DomainError, withContext, type Database } from '../db';
import { setCategoryPaused, setOrderingPaused, setProductAvailable } from '../catalog-admin';
import { createCategory, createProduct, listCategories, listProducts, updateCategory, updateProduct } from '../catalog-service';
import { buildCheckout } from '../checkout-service';
import { createLocation, listLocations, locationQrSvg, qrUrlFor, resolveLocationByToken, rotateLocationQr, updateLocation } from '../locations-admin';
import { confirmLimitsReviewed, getLimitsReport, updateLimits } from '../limits-service';
import { resolveTenantBySlug } from '../menu';
import { ROLES, addMember, listMembers, updateMember } from '../staff-admin';
import { createPickupPoint, listPickupPoints, updatePickupPoint } from '../pickup-points-admin';
import { listNotifications, markNotificationsRead } from '../notifications';
import { createOrder, markPartReady, redeemPickup, transitionOrder } from '../order-service';
import type { InMemoryHub } from '../realtime';
import { handlePaymentWebhook } from '../payments/payment-service';
import { listRefunds, retryRefund } from '../payments/refund-admin';
import type { PaymentProvider } from '../payments/provider';
import type { SimulatedProvider } from '../payments/simulated';
import { getCustomerOrder, getPublicMenu, getVenueQueue } from '../read-models';

export interface AppConfig {
  db: Database;
  pickupSecret: string;
  webhookSecret: string;
  encryptionKey: Buffer;
  provider: PaymentProvider;
  /** Dirección pública de esta API (para los avisos del proveedor) y de la app web (a donde vuelve el cliente tras pagar). */
  publicApiUrl: string;
  appBaseUrl: string;
  /** Solo desarrollo: habilita la página de pago simulada. Nunca en producción. */
  simulated?: SimulatedProvider;
  /** Registro de eventos (JSON a stdout). Nunca incluye cookies ni credenciales. */
  logger?: boolean;
  /** Difusión en tiempo real (SSE). Si no se indica, los endpoints de eventos no se registran. */
  hub?: InMemoryHub;
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
  RATE_LIMITED: 429, IDEMPOTENCY_KEY_REQUIRED: 400, USER_NOT_FOUND: 404, MEMBER_NOT_FOUND: 404, MEMBER_ALREADY_EXISTS: 409, LAST_OWNER: 409, USER_BLOCKED: 409,
  PRODUCT_NAME_TAKEN: 409, CATEGORY_NAME_TAKEN: 409, CATEGORY_NOT_EMPTY: 409, PICKUP_POINT_NOT_FOUND: 404, POINT_NAME_TAKEN: 409, DEFAULT_POINT_CANNOT_BE_DEACTIVATED: 409, DEFAULT_POINT_REQUIRED: 409, LOCATION_NOT_FOUND: 404, LOCATION_NAME_TAKEN: 409, PRODUCT_NOT_FOUND: 404, CATEGORY_NOT_FOUND: 404, REFUND_NOT_FOUND: 404, REFUND_NOT_RETRYABLE: 409,
  ORDER_NOT_PAYABLE: 409, PAYMENT_WINDOW_EXPIRED: 409, PAYMENT_ACCOUNT_NOT_CONNECTED: 409,
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
  limits: z.object({
    maxTotalCents: z.number().int().optional(), maxIndividualItems: z.number().int().optional(), maxCombos: z.number().int().optional(),
    maxTotalOnPickupCents: z.number().int().optional(), paymentWindowMinutes: z.number().int().optional(),
  }).strict(),
  redeem: z.object({ token: z.string().max(200).optional(), shortCode: z.string().max(12).optional() }),
};

export async function buildApp(cfg: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: cfg.logger ? { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-signature"]'] } : false,
    bodyLimit: 100_000,
  });
  await app.register(cookie);
  const role = cfg.dbRole;

  // Cuerpo JSON conservando el texto original (la firma del webhook se calcula sobre él).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
    try { done(null, body ? JSON.parse(body as string) : {}); } catch (e) { done(Object.assign(e as Error, { statusCode: 400 }), undefined); }
  });

  /* ---------- errores ---------- */
  app.setErrorHandler((err, _req, reply) => {
    // Los avisos de pago rechazados son lo más difícil de diagnosticar desde afuera: se anota por qué (solo nombres de cabeceras).
    if (_req.url.startsWith('/webhooks/')) app.log.warn({ code: (err as { code?: string }).code ?? err.name, headerNames: Object.keys(_req.headers) }, 'webhook rechazado');
    if (err instanceof ZodError) return reply.code(400).send({ code: 'VALIDATION', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    if (err instanceof OrderLimitError) return reply.code(422).send({ code: err.code, violations: err.violations, usage: err.usage });
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

  /** Inicia el cobro: devuelve la dirección del proveedor (o de la página simulada) a la que se envía al cliente. */
  app.post('/orders/:id/checkout', async (req) => {
    const user = await currentUser(req); const id = idParam(req);
    const tenantId = await ownOrderTenant(user.id, id);
    const { input, accessToken } = await withContext(cfg.db, { tenantId, userId: user.id, role }, (tx) => buildCheckout(tx, {
      tenantId, userId: user.id, orderId: id, provider: cfg.provider.name, encryptionKey: cfg.encryptionKey,
      urls: {
        notificationUrl: `${cfg.publicApiUrl}/webhooks/mercadopago`,
        backUrls: { success: `${cfg.appBaseUrl}/orders/${id}?pago=ok`, failure: `${cfg.appBaseUrl}/orders/${id}?pago=error`, pending: `${cfg.appBaseUrl}/orders/${id}?pago=pendiente` },
      },
    }));
    const out = await cfg.provider.createCheckout(accessToken, input);   // llamada de red: fuera de la transacción
    return { checkoutUrl: out.checkoutUrl, expiresAt: input.expiresAt.toISOString() };
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

  /* ---------- sectores de origen y sus QR ---------- */
  // Público: el cliente escanea un QR y la app consulta a qué sector corresponde para precargar el origen (informativo).
  app.get('/venues/:slug/locations/by-token/:token', async (req) => {
    const t = await tenantOf((req.params as { slug: string }).slug);
    const token = z.string().regex(/^[a-f0-9]{64}$/).parse((req.params as { token: string }).token);
    const loc = await withContext(cfg.db, { tenantId: t.id, role }, (tx) => resolveLocationByToken(tx, t.id, token));
    if (!loc) throw new DomainError('LOCATION_NOT_FOUND');
    return loc;
  });
  const qrUrlOf = (slug: string) => qrUrlFor(cfg.appBaseUrl, slug);
  app.get('/venues/:slug/staff/locations', async (req) => {
    const slug = (req.params as { slug: string }).slug;
    const { tenant, ctx } = await staff(req, slug, 'locations.manage');
    return withContext(cfg.db, ctx, (tx) => listLocations(tx, tenant.id, qrUrlOf(slug)));
  });
  app.post('/venues/:slug/staff/locations', async (req, reply) => {
    const slug = (req.params as { slug: string }).slug;
    const { tenant, user, ctx } = await staff(req, slug, 'locations.manage');
    const b = z.object({ name: z.string().min(1).max(60), kind: z.enum(['table', 'bar', 'sector', 'other']).default('sector') }).strict().parse(req.body);
    return reply.code(201).send(await withContext(cfg.db, ctx, (tx) => createLocation(tx, { tenantId: tenant.id, actorUserId: user.id, ...b }, qrUrlOf(slug))));
  });
  app.put('/venues/:slug/staff/locations/:id', async (req) => {
    const slug = (req.params as { slug: string }).slug;
    const { tenant, user, ctx } = await staff(req, slug, 'locations.manage');
    const b = z.object({ name: z.string().min(1).max(60).optional(), active: z.boolean().optional() }).strict().parse(req.body);
    return withContext(cfg.db, ctx, (tx) => updateLocation(tx, { tenantId: tenant.id, actorUserId: user.id, id: idParam(req), ...b }, qrUrlOf(slug)));
  });
  app.post('/venues/:slug/staff/locations/:id/rotate-qr', async (req) => {
    const slug = (req.params as { slug: string }).slug;
    const { tenant, user, ctx } = await staff(req, slug, 'locations.manage');
    return withContext(cfg.db, ctx, (tx) => rotateLocationQr(tx, { tenantId: tenant.id, actorUserId: user.id, id: idParam(req) }, qrUrlOf(slug)));
  });
  app.get('/venues/:slug/staff/locations/:id/qr.svg', async (req, reply) => {
    const slug = (req.params as { slug: string }).slug;
    const { tenant, ctx } = await staff(req, slug, 'locations.manage');
    const svg = await withContext(cfg.db, ctx, (tx) => locationQrSvg(tx, tenant.id, idParam(req), qrUrlOf(slug)));
    return reply.type('image/svg+xml').header('Cache-Control', 'no-store').send(svg);
  });

  /* ---------- catálogo: categorías, productos, variantes y combos ---------- */
  const groupSchema = z.object({
    name: z.string().min(1).max(60), minSelect: z.number().int(), maxSelect: z.number().int(),
    options: z.array(z.object({ name: z.string().min(1).max(60), priceDeltaCents: z.number().int().optional(), available: z.boolean().optional() }).strict()).max(50),
  }).strict();
  const productFields = {
    name: z.string().min(1).max(120), description: z.string().max(500).nullish(), ingredients: z.string().max(500).nullish(), imageUrl: z.string().url().max(500).nullish(),
    basePriceCents: z.number().int(), prepMinutes: z.number().int(), kind: z.enum(['simple', 'combo']), pickupPointId: uuid.nullish(), available: z.boolean().optional(),
  };
  /** Tras tocar precios se devuelve el informe de límites: avisa si un precio hace inalcanzable un tope (p. ej. combos de más de $12.500). */
  const withLimitsReport = async (tx: Parameters<typeof getLimitsReport>[0], tenantId: string, body: object) => ({ ...body, limitsIssues: (await getLimitsReport(tx, tenantId)).issues });

  app.get('/venues/:slug/staff/categories', async (req) => {
    const { tenant, ctx } = await staff(req, (req.params as { slug: string }).slug, 'catalog.manage');
    return withContext(cfg.db, ctx, (tx) => listCategories(tx, tenant.id, { includeArchived: (req.query as { archived?: string }).archived === '1' }));
  });
  app.post('/venues/:slug/staff/categories', async (req, reply) => {
    const { tenant, user, ctx } = await staff(req, (req.params as { slug: string }).slug, 'catalog.manage');
    const b = z.object({ name: z.string().min(1).max(60), pickupPointId: uuid.nullish() }).strict().parse(req.body);
    return reply.code(201).send(await withContext(cfg.db, ctx, (tx) => createCategory(tx, { tenantId: tenant.id, actorUserId: user.id, ...b })));
  });
  app.put('/venues/:slug/staff/categories/:id', async (req) => {
    const { tenant, user, ctx } = await staff(req, (req.params as { slug: string }).slug, 'catalog.manage');
    const b = z.object({ name: z.string().min(1).max(60).optional(), sortOrder: z.number().int().optional(), pickupPointId: uuid.nullish(), archived: z.boolean().optional() }).strict().parse(req.body);
    return withContext(cfg.db, ctx, (tx) => updateCategory(tx, { tenantId: tenant.id, actorUserId: user.id, id: idParam(req), patch: b }));
  });
  app.get('/venues/:slug/staff/products', async (req) => {
    const { tenant, ctx } = await staff(req, (req.params as { slug: string }).slug, 'catalog.manage');
    return withContext(cfg.db, ctx, (tx) => listProducts(tx, tenant.id, { includeArchived: (req.query as { archived?: string }).archived === '1' }));
  });
  app.post('/venues/:slug/staff/products', async (req, reply) => {
    const { tenant, user, ctx } = await staff(req, (req.params as { slug: string }).slug, 'catalog.manage');
    const b = z.object({ categoryId: uuid, ...productFields, groups: z.array(groupSchema).max(20).optional() }).strict().parse(req.body);
    const { categoryId, groups, ...fields } = b;
    return reply.code(201).send(await withContext(cfg.db, ctx, async (tx) =>
      withLimitsReport(tx, tenant.id, await createProduct(tx, { tenantId: tenant.id, actorUserId: user.id, categoryId, fields, groups }))));
  });
  app.put('/venues/:slug/staff/products/:id', async (req) => {
    const { tenant, user, ctx } = await staff(req, (req.params as { slug: string }).slug, 'catalog.manage');
    const b = z.object({ categoryId: uuid.optional(), ...Object.fromEntries(Object.entries(productFields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])), archived: z.boolean().optional(), groups: z.array(groupSchema).max(20).optional() }).strict().parse(req.body);
    return withContext(cfg.db, ctx, async (tx) => withLimitsReport(tx, tenant.id, await updateProduct(tx, { tenantId: tenant.id, actorUserId: user.id, productId: idParam(req), patch: b as never })));
  });

  /* ---------- equipo del local (solo el dueño) ---------- */
  app.get('/venues/:slug/staff/members', async (req) => {
    const { tenant, ctx } = await staff(req, (req.params as { slug: string }).slug, 'staff.manage');
    return withContext(cfg.db, ctx, (tx) => listMembers(tx, tenant.id));
  });
  app.post('/venues/:slug/staff/members', async (req, reply) => {
    const { tenant, user, ctx } = await staff(req, (req.params as { slug: string }).slug, 'staff.manage');
    const b = z.object({ email: z.string().email().max(254), role: z.enum(ROLES as unknown as [string, ...string[]]) }).strict().parse(req.body);
    return reply.code(201).send(await withContext(cfg.db, ctx, (tx) => addMember(tx, { tenantId: tenant.id, actorUserId: user.id, email: b.email, role: b.role as never })));
  });
  app.put('/venues/:slug/staff/members/:id', async (req) => {
    const { tenant, user, ctx } = await staff(req, (req.params as { slug: string }).slug, 'staff.manage');
    const b = z.object({ role: z.enum(ROLES as unknown as [string, ...string[]]).optional(), active: z.boolean().optional() }).strict().parse(req.body);
    return withContext(cfg.db, ctx, (tx) => updateMember(tx, { tenantId: tenant.id, actorUserId: user.id, userId: idParam(req), role: b.role as never, active: b.active }));
  });

  /* ---------- puntos de retiro ---------- */
  app.get('/venues/:slug/staff/pickup-points', async (req) => {
    const { tenant, ctx } = await staff(req, (req.params as { slug: string }).slug, 'locations.manage');
    return withContext(cfg.db, ctx, (tx) => listPickupPoints(tx, tenant.id));
  });
  app.post('/venues/:slug/staff/pickup-points', async (req, reply) => {
    const { tenant, user, ctx } = await staff(req, (req.params as { slug: string }).slug, 'locations.manage');
    const b = z.object({ name: z.string().min(1).max(60), description: z.string().max(200).nullish(), makeDefault: z.boolean().optional() }).strict().parse(req.body);
    return reply.code(201).send(await withContext(cfg.db, ctx, (tx) => createPickupPoint(tx, { tenantId: tenant.id, actorUserId: user.id, ...b })));
  });
  app.put('/venues/:slug/staff/pickup-points/:id', async (req) => {
    const { tenant, user, ctx } = await staff(req, (req.params as { slug: string }).slug, 'locations.manage');
    const b = z.object({ name: z.string().min(1).max(60).optional(), description: z.string().max(200).nullish(), active: z.boolean().optional(), isDefault: z.boolean().optional() }).strict().parse(req.body);
    return withContext(cfg.db, ctx, (tx) => updatePickupPoint(tx, { tenantId: tenant.id, actorUserId: user.id, id: idParam(req), ...b }));
  });

  /* ---------- control operativo rápido: agotar productos, pausar categorías y pausar pedidos ---------- */
  app.put('/venues/:slug/staff/products/:id/availability', async (req) => {
    const { tenant, user, ctx } = await staff(req, (req.params as { slug: string }).slug, 'availability.update');
    const b = z.object({ available: z.boolean() }).strict().parse(req.body);
    return withContext(cfg.db, ctx, (tx) => setProductAvailable(tx, { tenantId: tenant.id, productId: idParam(req), available: b.available, actorUserId: user.id }));
  });
  app.put('/venues/:slug/staff/categories/:id/pause', async (req) => {
    const { tenant, user, ctx } = await staff(req, (req.params as { slug: string }).slug, 'availability.update');
    const b = z.object({ paused: z.boolean() }).strict().parse(req.body);
    return withContext(cfg.db, ctx, (tx) => setCategoryPaused(tx, { tenantId: tenant.id, categoryId: idParam(req), paused: b.paused, actorUserId: user.id }));
  });
  app.put('/venues/:slug/staff/ordering', async (req) => {
    const { tenant, user, ctx } = await staff(req, (req.params as { slug: string }).slug, 'availability.update');
    const b = z.object({ paused: z.boolean(), message: z.string().max(200).nullish() }).strict().parse(req.body);
    return withContext(cfg.db, ctx, (tx) => setOrderingPaused(tx, { tenantId: tenant.id, paused: b.paused, message: b.message, actorUserId: user.id }));
  });

  /* ---------- reembolsos: ver los pendientes y fallidos, y reintentar a mano ---------- */
  app.get('/venues/:slug/staff/refunds', async (req) => {
    const { tenant, ctx } = await staff(req, (req.params as { slug: string }).slug, 'refunds.issue');
    const status = z.enum(['pending', 'succeeded', 'failed']).optional().parse((req.query as { status?: string }).status);
    return withContext(cfg.db, ctx, (tx) => listRefunds(tx, tenant.id, { status }));
  });
  app.post('/venues/:slug/staff/refunds/:id/retry', async (req) => {
    const { tenant, user, ctx } = await staff(req, (req.params as { slug: string }).slug, 'refunds.issue');
    await withContext(cfg.db, ctx, (tx) => retryRefund(tx, { tenantId: tenant.id, refundId: idParam(req), actorUserId: user.id }));
    return { retrying: true };
  });

  /* ---------- límites por pedido del local ---------- */
  // El informe avisa si los topes se pisan con los precios (p. ej. combos que impiden llegar a 8) y si toca revisarlos por inflación.
  app.get('/venues/:slug/staff/limits', async (req) => {
    const { tenant, ctx } = await staff(req, (req.params as { slug: string }).slug, 'catalog.manage');
    return withContext(cfg.db, ctx, (tx) => getLimitsReport(tx, tenant.id));
  });
  app.put('/venues/:slug/staff/limits', async (req) => {
    const { tenant, user, ctx } = await staff(req, (req.params as { slug: string }).slug, 'venue.configure');
    const b = schemas.limits.parse(req.body);
    return withContext(cfg.db, ctx, (tx) => updateLimits(tx, { tenantId: tenant.id, actorUserId: user.id, changes: b }));
  });
  app.post('/venues/:slug/staff/limits/confirm', async (req) => {
    const { tenant, user, ctx } = await staff(req, (req.params as { slug: string }).slug, 'venue.configure');
    return withContext(cfg.db, ctx, (tx) => confirmLimitsReviewed(tx, { tenantId: tenant.id, actorUserId: user.id }));
  });

  /* ---------- webhook del proveedor de pagos (sin cookie: se autentica por firma) ---------- */
  app.post('/webhooks/mercadopago', async (req, reply) => {
    // Mercado Pago manda cada pago en dos formatos: el actual (?data.id=…&type=payment) y uno antiguo (?id=…&topic=payment).
    // El antiguo no se procesa (el actual ya trae todo): se responde 200 para que no lo reintente.
    const q = req.query as Record<string, string | undefined>;
    if (q.topic && !q['data.id']) return reply.code(200).send({ outcome: 'ignored' });
    const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
    const r = await handlePaymentWebhook(
      { db: cfg.db, provider: cfg.provider, webhookSecret: cfg.webhookSecret, encryptionKey: cfg.encryptionKey, role },
      { rawBody: raw, headers, query: req.query as Record<string, string | undefined> });
    return reply.code(200).send(r);   // 200 evita reintentos del proveedor; los errores reales devuelven 4xx/5xx
  });

  /* ---------- SOLO DESARROLLO: página de pago simulada ---------- */
  if (cfg.simulated) {
    const sim = cfg.simulated;
    app.get('/dev/pay/:orderId', async (req, reply) => {
      const id = uuid.parse((req.params as { orderId: string }).orderId);
      const info = sim.checkoutFor(id);
      if (!info) throw new DomainError('ORDER_NOT_FOUND');
      const money = new Intl.NumberFormat('es-AR', { style: 'currency', currency: info.currency }).format(info.totalCents / 100);
      const rows = info.items.map((i) => `<li>${i.quantity} × ${i.title.replace(/[<>&"]/g, '')}</li>`).join('');
      return reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pago simulado</title>
<body style="font-family:system-ui;max-width:420px;margin:40px auto;padding:0 16px;color:#1b1f3b">
<p style="background:#fff4dd;color:#7a4b00;padding:8px 12px;border-radius:8px">⚠ Pago SIMULADO (solo desarrollo). No se cobra nada.</p>
<h1>Pedido #${String(info.orderNumber).padStart(3, '0')}</h1><ul>${rows}</ul><h2>Total: ${money}</h2>
<button id="ok" style="width:100%;padding:14px;font-size:16px;border:0;border-radius:12px;background:#3451d1;color:#fff;margin-bottom:8px">Aprobar pago</button>
<button id="no" style="width:100%;padding:14px;font-size:16px;border:0;border-radius:12px;background:#fdecea;color:#b3261e">Rechazar pago</button>
<p id="msg" role="status"></p>
<script>for (const [btn, outcome] of [['ok','approve'],['no','reject']]) document.getElementById(btn).onclick = async () => {
  const r = await fetch('/dev/pay/${id}/' + outcome, { method: 'POST' }); const j = await r.json();
  document.getElementById('msg').textContent = r.ok ? 'Listo. Volviendo…' : 'Error: ' + j.code;
  if (r.ok) setTimeout(() => { location.href = j.returnUrl; }, 600); };</script></body></html>`);
    });
    app.post('/dev/pay/:orderId/:outcome', async (req) => {
      const { orderId, outcome } = req.params as { orderId: string; outcome: string };
      const id = uuid.parse(orderId);
      if (outcome !== 'approve' && outcome !== 'reject') throw new DomainError('INVALID_OUTCOME');
      const info = sim.checkoutFor(id);
      if (!info) throw new DomainError('ORDER_NOT_FOUND');
      const acc = (await withContext(cfg.db, { admin: true, role }, (tx) => tx.query<{ provider_account_id: string }>(
        "SELECT a.provider_account_id FROM tenant_payment_accounts a JOIN orders o ON o.tenant_id = a.tenant_id WHERE o.id = $1 AND a.provider = 'simulated'", [id]))).rows[0];
      if (!acc) throw new DomainError('PAYMENT_ACCOUNT_NOT_CONNECTED');
      const wh = sim.announce({ orderId: id, amountCents: info.totalCents, status: outcome === 'approve' ? 'approved' : 'rejected', accountId: acc.provider_account_id, secret: cfg.webhookSecret });
      const result = await handlePaymentWebhook({ db: cfg.db, provider: cfg.provider, webhookSecret: cfg.webhookSecret, encryptionKey: cfg.encryptionKey, role }, { rawBody: wh.rawBody, headers: wh.headers });
      return { outcome: result.outcome, returnUrl: `${cfg.appBaseUrl}/orders/${id}?pago=${outcome === 'approve' ? 'ok' : 'error'}` };
    });
  }

  /* ---------- tiempo real (SSE) ---------- */
  // El estado de verdad siempre se pide por GET; SSE solo avisa que algo cambió (al reconectar, el cliente re-consulta).
  const stream = (req: FastifyRequest, reply: FastifyReply, channel: string) => {
    const hub = cfg.hub as InMemoryHub;
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    raw.write(': conectado\n\n');
    const off = hub.subscribe(channel, (m) => raw.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`));
    const beat = setInterval(() => raw.write(': latido\n\n'), 25_000);
    const close = () => { clearInterval(beat); off(); };
    req.raw.on('close', close);
  };
  if (cfg.hub) {
    app.get('/events', async (req, reply) => { const u = await currentUser(req); stream(req, reply, `user:${u.id}`); });
    app.get('/venues/:slug/staff/events', async (req, reply) => {
      const { tenant } = await staff(req, (req.params as { slug: string }).slug, 'orders.view');
      stream(req, reply, `tenant:${tenant.id}`);
    });
  }

  app.get('/health', async () => ({ ok: true }));
  return app;
}
