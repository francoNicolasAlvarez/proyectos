/**
 * Servidor SOLO PARA PRUEBAS E2E del frontend: PGlite en memoria, pago simulado y datos sembrados.
 * No usa .env ni credenciales reales. Cada arranque empieza de cero.
 *
 *   E2E_API_PORT (3100)  ·  E2E_WEB_ORIGIN (http://localhost:5174)
 */
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { allSql } from '../db/schema.mjs';
import { encryptSecret } from '../src/crypto-box';
import type { Database } from '../src/db';
import { buildApp } from '../src/http/app';
import { dispatchOutbox } from '../src/notifications';
import { SimulatedProvider } from '../src/payments/simulated';
import { InMemoryHub } from '../src/realtime';

const port = Number(process.env.E2E_API_PORT ?? 3100);
const webOrigin = process.env.E2E_WEB_ORIGIN ?? 'http://localhost:5174';
const apiOrigin = `http://127.0.0.1:${port}`;   // 127.0.0.1: evita que localhost resuelva a IPv6
export const STAFF = { email: 'staff@e2e.test', password: 'clave-de-prueba-1' };

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const pg = new PGlite();
await pg.exec(allSql());
const one = async (sql: string, p: unknown[] = []) => (await pg.query<Row>(sql, p)).rows[0] as Row;

const key = randomBytes(32);
const tenant = (await one("INSERT INTO tenants (name, slug) VALUES ('Cervecería El Faro','el-faro') RETURNING id")).id as string;
await pg.query('INSERT INTO tenant_settings (tenant_id) VALUES ($1)', [tenant]);
await pg.query("INSERT INTO tenant_payment_methods (tenant_id, method, enabled) VALUES ($1,'card_online',true),($1,'payment_app',true)", [tenant]);
await pg.query("INSERT INTO pickup_points (tenant_id, name, is_default) VALUES ($1,'Barra principal',true)", [tenant]);
await pg.query("INSERT INTO tenant_payment_accounts (tenant_id, provider, provider_account_id, access_token_enc) VALUES ($1,'simulated','SIM-E2E',$2)", [tenant, encryptSecret('simulated', key)]);
await pg.query("INSERT INTO locations (tenant_id, name, kind) VALUES ($1,'Mesa 4','table')", [tenant]);

const menu = (await one("INSERT INTO menus (tenant_id, name, is_default) VALUES ($1,'Carta',true) RETURNING id", [tenant])).id;
const cat = async (name: string, sort: number) => (await one('INSERT INTO categories (tenant_id, menu_id, name, sort_order) VALUES ($1,$2,$3,$4) RETURNING id', [tenant, menu, name, sort])).id;
const prod = async (c: string, name: string, cents: number, kind = 'simple', available = true) =>
  (await one('INSERT INTO products (tenant_id, category_id, name, base_price_cents, kind, available) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [tenant, c, name, cents, kind, available])).id as string;

const beers = await cat('Cervezas', 1); const combos = await cat('Combos', 2);
const lager = await prod(beers, 'Rubia Lager', 400_000);
await prod(beers, 'IPA Especial', 500_000, 'simple', false);
await prod(combos, 'Combo 3', 1_290_000, 'combo');
const group = (await one("INSERT INTO option_groups (tenant_id, product_id, name, min_select, max_select) VALUES ($1,$2,'Tamaño',1,1) RETURNING id", [tenant, lager])).id;
await pg.query("INSERT INTO options (tenant_id, group_id, name, price_delta_cents, sort_order) VALUES ($1,$2,'Pinta',0,1),($1,$2,'Jarra',300000,2)", [tenant, group]);

const hub = new InMemoryHub();
const provider = new SimulatedProvider(apiOrigin);
const db = pg as unknown as Database;
const app = await buildApp({
  db, hub, pickupSecret: 'e2e-pickup', webhookSecret: 'e2e-webhook', encryptionKey: key, provider, simulated: provider,
  publicApiUrl: apiOrigin, appBaseUrl: webOrigin, allowedOrigins: [webOrigin, apiOrigin], secureCookies: false, dbRole: 'app_runtime',
  scryptCost: 2 ** 10, logger: false,
});

// Personal del local para que las pruebas avancen los pedidos por la API.
const reg = await app.inject({ method: 'POST', url: '/auth/register', payload: { email: STAFF.email, name: 'Personal E2E', password: STAFF.password, adultDeclared: true } });
const staffId = (reg.json() as { id: string }).id;
await pg.query("INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1,$2,'owner')", [tenant, staffId]);

setInterval(() => { void dispatchOutbox(db, hub).catch(() => undefined); }, 500).unref();
await app.listen({ port, host: '127.0.0.1' });
console.log(`E2E_API_LISTO ${apiOrigin}`);
