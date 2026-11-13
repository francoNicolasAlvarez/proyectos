/** Acceso a datos mínimo e independiente del driver (PGlite en pruebas, node-postgres en producción). */

export interface QueryResult<T = Record<string, unknown>> { rows: T[]; affectedRows?: number }
export interface Queryable { query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> }
export interface Database extends Queryable { transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> }

export interface RequestContext {
  tenantId?: string;
  userId?: string;
  /** Solo el servidor lo activa, tras verificar users.is_platform_admin. */
  admin?: boolean;
  /** Rol de base de datos al que cambiar (en pruebas, para ejercitar RLS con un propietario superusuario). */
  role?: string;
}

/**
 * Ejecuta fn en una transacción con el contexto de tenant/usuario fijado para RLS.
 * Es la ÚNICA forma prevista de acceder a datos de negocio desde la API.
 */
export async function withContext<T>(db: Database, ctx: RequestContext, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    if (ctx.role) await tx.query(`SET LOCAL ROLE ${ctx.role.replace(/[^a-z_]/gi, '')}`);
    await tx.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.is_admin', $3, true)",
      [ctx.tenantId ?? '', ctx.userId ?? '', ctx.admin ? 'on' : ''],
    );
    return fn(tx);
  });
}

/** Errores de negocio con código estable (la API los traduce a respuestas HTTP). */
export class DomainError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'DomainError';
  }
}

export const num = (v: unknown): number => Number(v);
