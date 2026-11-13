/** Adaptador de node-postgres a la interfaz Database. Cada transacción usa una conexión propia del pool. */
import type { Pool } from 'pg';
import type { Database, Queryable } from './db';

export function pgDatabase(pool: Pool): Database {
  const wrap = (c: { query: Pool['query'] }): Queryable => ({
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      const r = await c.query(sql, params as unknown[]);
      return { rows: r.rows as T[], affectedRows: r.rowCount ?? undefined };
    },
  });
  return {
    ...wrap(pool),
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
  };
}
