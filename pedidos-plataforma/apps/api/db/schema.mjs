/**
 * Migraciones de la base de datos: archivos db/migrations/NNNN_nombre.sql aplicados en orden.
 * Compartido por las pruebas (que arman una base nueva con todo) y por db-setup (que aplica solo las pendientes).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export const migrationFiles = () => readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
export const migrationSql = (file) => readFileSync(join(dir, file), 'utf8');
/** Todo el esquema, para bases nuevas de prueba. */
export const allSql = () => migrationFiles().map(migrationSql).join('\n');

/**
 * Aplica las migraciones pendientes sobre un cliente `pg` ya conectado como administrador.
 * Cada archivo corre en su propia transacción y queda registrado en schema_migrations.
 * Reconoce bases anteriores a este registro (que ya tenían la 0001) y no la repite.
 */
export async function applyPending(client, log = () => {}) {
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const legacy = (await client.query("SELECT to_regclass('public.orders') AS t")).rows[0].t;
  const first = migrationFiles()[0];
  if (legacy && first) await client.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [first]);
  const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const applied = [];
  for (const file of migrationFiles()) {
    if (done.has(file)) continue;
    await client.query('BEGIN');
    try {
      await client.query(migrationSql(file));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`Migración ${file} falló: ${e.message}`);
    }
    log(`migración ${file}: aplicada`);
    applied.push(file);
  }
  if (!applied.length) log('migraciones: todo al día');
  return applied;
}
