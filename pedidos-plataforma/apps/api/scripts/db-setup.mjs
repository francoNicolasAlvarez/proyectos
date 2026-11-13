/**
 * Prepara la base de datos de desarrollo (PostgreSQL local). Repetible: se puede ejecutar de nuevo sin romper nada.
 *   1. crea las bases `pedidos` y `pedidos_test`
 *   2. aplica la migración a `pedidos` si todavía no está aplicada
 *   3. fija las contraseñas de `postgres` y del rol de la aplicación (`app_runtime`, con permiso de login)
 *   4. exige contraseña para las conexiones (pg_hba.conf: trust → scram-sha-256) y recarga la configuración
 *   5. verifica: la aplicación se conecta sin ser superusuario ni evitar RLS, y sin contraseña ya no se puede entrar
 * Lee las conexiones de ../../.env (DATABASE_URL, MIGRATION_DATABASE_URL). Nunca imprime contraseñas.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function loadEnv() {
  const out = {};
  for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2];
  }
  return out;
}
const env = loadEnv();
for (const k of ['DATABASE_URL', 'MIGRATION_DATABASE_URL']) if (!env[k]) throw new Error(`Falta ${k} en .env`);
const adminUrl = new URL(env.MIGRATION_DATABASE_URL);
const appUrl = new URL(env.DATABASE_URL);
const adminUser = decodeURIComponent(adminUrl.username);
const adminPassword = decodeURIComponent(adminUrl.password);
const appUser = decodeURIComponent(appUrl.username);
const appPassword = decodeURIComponent(appUrl.password);
const dbName = appUrl.pathname.slice(1);
const host = adminUrl.hostname;
const port = Number(adminUrl.port || 5432);

const client = (user, password, database) => new pg.Client({ host, port, user, password, database });
const log = (m) => console.log('·', m);

async function ensureDatabase(c, name) {
  const exists = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (exists.rows.length) return log(`base ${name}: ya existía`);
  await c.query(`CREATE DATABASE ${c.escapeIdentifier(name)} ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`);
  log(`base ${name}: creada`);
}

const admin = client(adminUser, adminPassword, 'postgres');
await admin.connect();
await ensureDatabase(admin, dbName);
await ensureDatabase(admin, `${dbName}_test`);

// 2. migración
const mig = client(adminUser, adminPassword, dbName);
await mig.connect();
const applied = (await mig.query("SELECT to_regclass('public.orders') AS t")).rows[0].t;
if (applied) log('migración: ya estaba aplicada');
else {
  await mig.query(readFileSync(join(root, 'apps', 'api', 'db', 'migrations', '0001_init.sql'), 'utf8'));
  log('migración 0001_init: aplicada');
}

// 3. contraseñas y rol de la aplicación (la migración lo crea sin permiso de login)
await admin.query(`ALTER ROLE ${admin.escapeIdentifier(adminUser)} WITH PASSWORD ${admin.escapeLiteral(adminPassword)}`);
await admin.query(`ALTER ROLE ${admin.escapeIdentifier(appUser)} WITH LOGIN PASSWORD ${admin.escapeLiteral(appPassword)} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
log(`contraseñas fijadas para "${adminUser}" y "${appUser}" (con login)`);

// 4. exigir contraseña (solo después de fijarlas, para no quedar afuera)
const hbaPath = (await admin.query('SHOW hba_file')).rows[0].hba_file;
const hba = readFileSync(hbaPath, 'utf8');
const hardened = hba.split(/\r?\n/).map((l) => (/^\s*(local|host)\b/.test(l) ? l.replace(/\btrust\b/, 'scram-sha-256') : l)).join('\n');
if (hardened !== hba) { writeFileSync(hbaPath, hardened); await admin.query('SELECT pg_reload_conf()'); log('pg_hba.conf: ahora exige contraseña (scram-sha-256)'); }
else log('pg_hba.conf: ya exigía contraseña');
await mig.end(); await admin.end();

// 5. verificación
const app = client(appUser, appPassword, dbName);
await app.connect();
const who = (await app.query('SELECT current_user AS u, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user')).rows[0];
if (who.rolsuper || who.rolbypassrls) throw new Error('La aplicación NO debe ser superusuario ni evitar RLS');
const visible = (await app.query('SELECT count(*)::int n FROM orders')).rows[0].n;
await app.end();
log(`la aplicación se conecta como "${who.u}" (superusuario: no · evita RLS: no) y sin contexto de local ve ${visible} pedidos`);

try {
  const anon = client(appUser, '', dbName); await anon.connect(); await anon.end();
  throw new Error('¡Se pudo entrar sin contraseña!');
} catch (e) {
  if (/¡Se pudo/.test(e.message)) throw e;
  log('conexión sin contraseña: rechazada ✓');
}
console.log('\nBase de datos lista.');
