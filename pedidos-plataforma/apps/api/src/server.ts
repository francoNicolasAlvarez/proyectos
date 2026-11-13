/**
 * Arranque del servidor. Lee la configuración del entorno y falla de inmediato si falta algo o es débil.
 * NO probado contra un PostgreSQL real todavía (ver docs/progress-report.md).
 */
import { Pool } from 'pg';
import { z } from 'zod';
import { buildApp } from './http/app';
import { MercadoPagoProvider } from './payments/mercadopago';
import { pgDatabase } from './pg-database';

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
const app = await buildApp({
  db: pgDatabase(pool),
  pickupSecret: env.PICKUP_SECRET,
  webhookSecret: env.MP_WEBHOOK_SECRET,
  encryptionKey: Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64'),
  provider: new MercadoPagoProvider(),
  allowedOrigins: env.ALLOWED_ORIGINS,
  secureCookies: env.NODE_ENV === 'production',
});

const close = async () => { await app.close(); await pool.end(); process.exit(0); };
process.on('SIGTERM', close);
process.on('SIGINT', close);

await app.listen({ port: env.PORT, host: '0.0.0.0' });
