/**
 * Datos de demostración para desarrollo: un local ("Cervecería El Faro") con menú y una cuenta por cada rol.
 * Repetible: si el local ya existe, no hace nada. Usa la conexión de administración (MIGRATION_DATABASE_URL).
 * Las cuentas de demostración comparten una contraseña de prueba: NO usar este script en producción.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { registerUser } from '../src/auth';
import { encryptSecret } from '../src/crypto-box';
import { pgDatabase } from '../src/pg-database';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const env: Record<string, string> = {};
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !line.trim().startsWith('#')) env[m[1] as string] = m[2] as string;
}
const url = env.MIGRATION_DATABASE_URL;
if (!url) throw new Error('Falta MIGRATION_DATABASE_URL en .env');

export const DEMO_PASSWORD = 'Demo-Pasamanos-2026';
export const DEMO_ACCOUNTS = [
  { email: 'cliente@demo.pasamanos.test', name: 'Cliente Demo', role: null as string | null },
  { email: 'dueno@demo.pasamanos.test', name: 'Dueño Demo', role: 'owner' },
  { email: 'gerente@demo.pasamanos.test', name: 'Gerente Demo', role: 'manager' },
  { email: 'pedidos@demo.pasamanos.test', name: 'Operador de pedidos Demo', role: 'order_operator' },
  { email: 'entrega@demo.pasamanos.test', name: 'Operador de entrega Demo', role: 'pickup_operator' },
  { email: 'admin@demo.pasamanos.test', name: 'Administrador de plataforma Demo', role: 'platform_admin' },
];

const pool = new pg.Pool({ connectionString: url, max: 2 });
const q = async <T extends Record<string, any>>(sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows as T[]; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Cuenta de cobro SIMULADA del local (solo desarrollo): permite pagar sin Mercado Pago. Repetible. */
const ensureSimulatedAccount = async (tenantId: string) => {
  if (!env.TOKEN_ENCRYPTION_KEY) throw new Error('Falta TOKEN_ENCRYPTION_KEY en .env');
  const r = await q("INSERT INTO tenant_payment_accounts (tenant_id, provider, provider_account_id, access_token_enc) VALUES ($1,'simulated','SIM-EL-FARO',$2) ON CONFLICT DO NOTHING RETURNING id",
    [tenantId, encryptSecret('simulated', Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64'))]);
  if (r.length) console.log('· Cuenta de cobro simulada conectada al local.');
};

const exists = await q("SELECT id FROM tenants WHERE lower(slug) = 'el-faro'");
if (exists.length) {
  await ensureSimulatedAccount(exists[0]!.id as string);
  console.log('· El local de demostración ya existe: no se cambió nada más.');
  await pool.end();
  process.exit(0);
}

const tenant = (await q<{ id: string }>("INSERT INTO tenants (name, slug, description, address) VALUES ('Cervecería El Faro','el-faro','Cervecería artesanal de demostración','Av. Siempreviva 742') RETURNING id"))[0]!.id;
await q('INSERT INTO tenant_settings (tenant_id, pickup_mode) VALUES ($1, $2)', [tenant, 'per_item']);
await q("INSERT INTO tenant_payment_methods (tenant_id, method, enabled) VALUES ($1,'payment_app',true),($1,'card_online',true),($1,'cash_on_pickup',false),($1,'card_on_pickup',false)", [tenant]);
await ensureSimulatedAccount(tenant);
const barra = (await q<{ id: string }>("INSERT INTO pickup_points (tenant_id, name, description, is_default, sort_order) VALUES ($1,'Barra 1','Bebidas',true,1) RETURNING id", [tenant]))[0]!.id;
const comida = (await q<{ id: string }>("INSERT INTO pickup_points (tenant_id, name, description, sort_order) VALUES ($1,'Punto de comida','Comidas y combos',2) RETURNING id", [tenant]))[0]!.id;
for (const [name, kind] of [['Mesa 5', 'table'], ['Barra principal', 'bar'], ['Sector VIP', 'sector'], ['Patio exterior', 'sector']] as const) {
  await q('INSERT INTO locations (tenant_id, name, kind) VALUES ($1,$2,$3)', [tenant, name, kind]);
}
const menu = (await q<{ id: string }>("INSERT INTO menus (tenant_id, name, is_default) VALUES ($1,'Carta',true) RETURNING id", [tenant]))[0]!.id;

const cat = async (name: string, order: number, point: string) =>
  (await q<{ id: string }>('INSERT INTO categories (tenant_id, menu_id, name, sort_order, pickup_point_id) VALUES ($1,$2,$3,$4,$5) RETURNING id', [tenant, menu, name, order, point]))[0]!.id;
const cervezas = await cat('Cervezas', 1, barra); const tragos = await cat('Tragos', 2, barra); const sinAlcohol = await cat('Sin alcohol', 3, barra);
const comidas = await cat('Comidas', 4, comida); const combos = await cat('Combos', 5, comida);

const product = async (category: string, name: string, description: string, price: number, prep: number, kind = 'simple', available = true) =>
  (await q<{ id: string }>('INSERT INTO products (tenant_id, category_id, name, description, base_price_cents, prep_minutes, kind, available) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
    [tenant, category, name, description, price * 100, prep, kind, available]))[0]!.id;
const group = async (productId: string, name: string, min: number, max: number, options: [string, number][]) => {
  const g = (await q<{ id: string }>('INSERT INTO option_groups (tenant_id, product_id, name, min_select, max_select) VALUES ($1,$2,$3,$4,$5) RETURNING id', [tenant, productId, name, min, max]))[0]!.id;
  let i = 0;
  for (const [n, delta] of options) await q('INSERT INTO options (tenant_id, group_id, name, price_delta_cents, sort_order) VALUES ($1,$2,$3,$4,$5)', [tenant, g, n, delta * 100, ++i]);
};
const size: [string, number][] = [['Pinta (473 ml)', 0], ['Jarra (1 L)', 3800]];
await group(await product(cervezas, 'Rubia Lager', 'Suave y refrescante.', 4200, 2), 'Tamaño', 1, 1, size);
await group(await product(cervezas, 'IPA de la casa', 'Amarga, cítrica, intensa.', 4600, 2), 'Tamaño', 1, 1, size);
await group(await product(tragos, 'Daikiri', 'Ron, limón y azúcar.', 6500, 6), 'Sabor', 1, 1, [['Clásico', 0], ['Frutilla', 500], ['Durazno', 500]]);
await product(tragos, 'Gin tonic', 'Gin, tónica y pepino.', 7000, 5, 'simple', false);
await group(await product(sinAlcohol, 'Limonada', 'Exprimida al momento.', 3200, 3), 'Agregados', 0, 2, [['Jengibre', 300], ['Menta', 300]]);
await group(await product(comidas, 'Papas fritas', 'Porción para compartir.', 5200, 12), 'Agregados', 0, 1, [['Cheddar y panceta', 1800]]);
await group(await product(comidas, 'Hamburguesa clásica', 'Carne, queso, lechuga y tomate.', 9800, 15), 'Agregados', 0, 2, [['Huevo', 800], ['Panceta', 1200]]);
const combo = await product(combos, 'Combo 3', 'Dos cervezas a elección y una porción de papas.', 11900, 12, 'combo');
const beers: [string, number][] = [['Rubia', 0], ['IPA', 400], ['Roja', 0]];
await group(combo, 'Cerveza 1', 1, 1, beers); await group(combo, 'Cerveza 2', 1, 1, beers);

// Cuentas de demostración (contraseñas con scrypt, igual que en producción)
const db = pgDatabase(pool);
for (const a of DEMO_ACCOUNTS) {
  const { userId } = await db.transaction((tx) => registerUser(tx, { email: a.email, name: a.name, password: DEMO_PASSWORD, adultDeclared: true }));
  if (a.role === 'platform_admin') await q('UPDATE users SET is_platform_admin = true WHERE id = $1', [userId]);
  else if (a.role) await q('INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)', [tenant, userId, a.role]);
}
console.log(`· Local "Cervecería El Faro" (slug el-faro) creado con 5 categorías, 8 productos y ${DEMO_ACCOUNTS.length} cuentas de demostración.`);
await pool.end();
