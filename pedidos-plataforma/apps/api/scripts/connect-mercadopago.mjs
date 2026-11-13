/**
 * Conecta la cuenta de Mercado Pago de PRUEBA de un local usando un Access Token (sin OAuth).
 * Sirve para el primer ensayo de punta a punta. El flujo OAuth, para que cada local conecte su propia cuenta,
 * se agrega después.
 *
 * Uso:   MP_TEST_ACCESS_TOKEN=... en .env  →  pnpm run db:connect-mp [slug-del-local]   (por defecto: el-faro)
 *
 * SIN VERIFICAR contra la API real: el endpoint /users/me y su respuesta están escritos de la documentación pública.
 * El token se guarda CIFRADO (AES-256-GCM con TOKEN_ENCRYPTION_KEY) y nunca se imprime.
 */
import { createCipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const env = {};
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !line.trim().startsWith('#')) env[m[1]] = m[2];
}
const token = env.MP_TEST_ACCESS_TOKEN;
const slug = (process.argv[2] ?? 'el-faro').toLowerCase();
if (!token) { console.error('Falta MP_TEST_ACCESS_TOKEN en .env'); process.exit(1); }
if (!env.TOKEN_ENCRYPTION_KEY || Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64').length !== 32) { console.error('TOKEN_ENCRYPTION_KEY inválida en .env'); process.exit(1); }

// Mismo formato que src/crypto-box.ts: v1.iv.tag.datos (base64url)
function encrypt(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64'), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

// 1. ¿De quién es el token? El webhook identifica al vendedor por su id de usuario en Mercado Pago.
const me = await fetch('https://api.mercadopago.com/users/me', { headers: { Authorization: `Bearer ${token}` } });
if (!me.ok) { console.error(`Mercado Pago rechazó el token (HTTP ${me.status}). Revisá que sea el Access Token de PRUEBA de tu aplicación.`); process.exit(1); }
const account = await me.json();
if (account.id == null) { console.error('La respuesta de Mercado Pago no trae el id de usuario.'); process.exit(1); }

// 2. Guardarlo cifrado para el local.
const db = new pg.Client({ connectionString: env.MIGRATION_DATABASE_URL });
await db.connect();
const t = (await db.query('SELECT id FROM tenants WHERE lower(slug) = $1', [slug])).rows[0];
if (!t) { console.error(`No existe el local "${slug}".`); process.exit(1); }
await db.query(
  `INSERT INTO tenant_payment_accounts (tenant_id, provider, provider_account_id, access_token_enc, status)
   VALUES ($1, 'mercadopago', $2, $3, 'active')
   ON CONFLICT (tenant_id, provider) DO UPDATE SET provider_account_id = EXCLUDED.provider_account_id, access_token_enc = EXCLUDED.access_token_enc, status = 'active'`,
  [t.id, String(account.id), encrypt(token)]);
await db.end();
console.log(`Cuenta de Mercado Pago (usuario ${account.id}${account.nickname ? ', ' + account.nickname : ''}) conectada al local "${slug}".`);
console.log('Para usarla, arrancá la API con PAYMENTS_MODE=mercadopago y PUBLIC_API_URL con la dirección pública (túnel).');
