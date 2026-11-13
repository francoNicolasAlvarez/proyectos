/**
 * Arranque del servidor. Lee la configuración del entorno y falla de inmediato si falta algo o es débil.
 * NO probado contra un PostgreSQL real todavía (ver docs/progress-report.md).
 */
import { Pool } from 'pg';
import { z } from 'zod';
import { buildApp } from './http/app';
import { MercadoPagoProvider } from './payments/mercadopago';
import { dispatchOutbox } from './notifications';
import { expireUnpaidOrders, processPendingRefunds } from './payments/payment-service';
import { pgDatabase } from './pg-database';
import { InMemoryHub } from './realtime';

const secret = z.string().min(32, 'debe tener al menos 32 caracteres');
const env = z.object({
  DATABASE_URL: z.string().url(),
  PICKUP_SECRET: secret,
  MP_WEBHOOK_SECRET: secret,
  /** 32 bytes en base64 (por ejemplo: openssl rand -base64 32). */
  TOKEN_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'debe ser 32 bytes en base64'),
  ALLOWED_ORIGINS: z.string().min(1).transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
  PORT: z.coerce.number().int().default(3000),
  NODE_ENV: z.string().default('development'),
}).parse(process.env);

const pool = new Pool({ connectionString: env.DATABASE_URL, max: 20 });
const db = pgDatabase(pool);
const hub = new InMemoryHub();
const provider = new MercadoPagoProvider();
const encryptionKey = Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64');
const app = await buildApp({
  db,
  hub,
  pickupSecret: env.PICKUP_SECRET,
  webhookSecret: env.MP_WEBHOOK_SECRET,
  encryptionKey,
  provider,
  allowedOrigins: env.ALLOWED_ORIGINS,
  secureCookies: env.NODE_ENV === 'production',
});

// Tareas periódicas. Con varias instancias son seguras: usan FOR UPDATE SKIP LOCKED y claves de idempotencia.
const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
  let running = false;
  const t = setInterval(async () => {
    if (running) return;            // sin solapar ejecuciones
    running = true;
    try { await fn(); } catch (e) { app.log.error({ err: e, task: name }, 'tarea periódica fallida'); } finally { running = false; }
  }, ms);
  t.unref();
  return t;
};
const timers = [
  every(1_000, 'outbox', () => dispatchOutbox(db, hub)),
  every(30_000, 'refunds', () => processPendingRefunds({ db, provider, webhookSecret: env.MP_WEBHOOK_SECRET, encryptionKey })),
  every(60_000, 'expire-unpaid', () => expireUnpaidOrders(db, { olderThanMinutes: 15 })),
];

const close = async () => { timers.forEach(clearInterval); await app.close(); await pool.end(); process.exit(0); };
process.on('SIGTERM', close);
process.on('SIGINT', close);

await app.listen({ port: env.PORT, host: '0.0.0.0' });
