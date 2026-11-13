/**
 * Cuentas y sesiones. Contraseñas con scrypt (incluido en Node, sin dependencias nativas);
 * sesiones en servidor con token aleatorio del que solo se guarda el hash (revocación inmediata).
 * El límite de intentos de login por IP/cuenta se aplica en la capa HTTP (Redis), no acá.
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { TenantRole } from '@pasamanos/shared';
import { DomainError, type Queryable } from './db';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

export const SESSION_DAYS = 30;
const DEFAULT_COST = 2 ** 15;
const KEYLEN = 64;

export async function hashPassword(password: string, cost = DEFAULT_COST): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N: cost, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return `scrypt$${cost}$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, key] = stored.split('$');
  if (alg !== 'scrypt' || !n || !r || !p || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * 1024 * 1024 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const normalizeEmail = (e: string) => e.trim().toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export function validatePassword(password: string, email: string): void {
  if (password.length < 8) throw new DomainError('PASSWORD_TOO_SHORT');
  if (password.length > 128) throw new DomainError('PASSWORD_TOO_LONG');
  if (password.toLowerCase() === normalizeEmail(email)) throw new DomainError('PASSWORD_SAME_AS_EMAIL');
}

export interface RegisterInput { email: string; name: string; password: string; phone?: string | null; adultDeclared: boolean; cost?: number }

export async function registerUser(tx: Queryable, i: RegisterInput): Promise<{ userId: string }> {
  const email = normalizeEmail(i.email);
  if (!EMAIL.test(email)) throw new DomainError('INVALID_EMAIL');
  if (!i.name.trim()) throw new DomainError('NAME_REQUIRED');
  if (!i.adultDeclared) throw new DomainError('ADULT_DECLARATION_REQUIRED');   // el local es responsable de verificar en el retiro
  validatePassword(i.password, email);
  const hash = await hashPassword(i.password, i.cost);
  const r = await tx.query<Row>(
    `INSERT INTO users (email, name, phone, password_hash, adult_declared_at) VALUES ($1,$2,$3,$4, now())
     ON CONFLICT DO NOTHING RETURNING id`, [email, i.name.trim(), i.phone ?? null, hash]);
  if (!r.rows[0]) throw new DomainError('EMAIL_TAKEN');
  return { userId: r.rows[0].id as string };
}

// Hash de relleno para igualar el tiempo de respuesta cuando el email no existe (evita enumerar cuentas).
let dummyHash: Promise<string> | undefined;
const dummy = (cost?: number) => (dummyHash ??= hashPassword('contraseña-de-relleno', cost));

export async function login(tx: Queryable, i: { email: string; password: string; ip?: string; userAgent?: string; cost?: number }): Promise<{ token: string; userId: string; expiresAt: Date }> {
  const u = (await tx.query<Row>('SELECT id, password_hash, status FROM users WHERE lower(email) = $1', [normalizeEmail(i.email)])).rows[0];
  const ok = await verifyPassword(i.password, u?.password_hash ?? (await dummy(i.cost)));
  if (!u || !u.password_hash || !ok) throw new DomainError('INVALID_CREDENTIALS');   // mismo error para email inexistente y contraseña errónea
  if (u.status !== 'active') throw new DomainError('ACCOUNT_BLOCKED');
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await tx.query('INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5)', [u.id, hashToken(token), expiresAt.toISOString(), i.ip ?? null, i.userAgent?.slice(0, 300) ?? null]);
  return { token, userId: u.id as string, expiresAt };
}

export interface AuthUser { id: string; name: string; isPlatformAdmin: boolean }

/** Devuelve el usuario de una sesión vigente, o null (inexistente, revocada, vencida o cuenta bloqueada). */
export async function authenticate(tx: Queryable, token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null;
  const r = (await tx.query<Row>(
    `SELECT u.id, u.name, u.is_platform_admin FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'`, [hashToken(token)])).rows[0];
  return r ? { id: r.id, name: r.name, isPlatformAdmin: r.is_platform_admin } : null;
}

export async function logout(tx: Queryable, token: string): Promise<void> {
  await tx.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [hashToken(token)]);
}

/** Cambia la contraseña y cierra todas las demás sesiones (la actual se conserva si se indica). */
export async function changePassword(tx: Queryable, i: { userId: string; current: string; next: string; keepToken?: string; cost?: number }): Promise<void> {
  const u = (await tx.query<Row>('SELECT email, password_hash FROM users WHERE id = $1', [i.userId])).rows[0];
  if (!u || !(await verifyPassword(i.current, u.password_hash))) throw new DomainError('INVALID_CREDENTIALS');
  validatePassword(i.next, u.email);
  await tx.query('UPDATE users SET password_hash = $2 WHERE id = $1', [i.userId, await hashPassword(i.next, i.cost)]);
  await tx.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND token_hash <> $2', [i.userId, i.keepToken ? hashToken(i.keepToken) : '']);
}

/** Locales con los que puede trabajar el usuario y con qué rol (requiere contexto app.user_id). */
export async function membershipsOf(tx: Queryable, userId: string): Promise<{ tenantId: string; role: TenantRole }[]> {
  const r = await tx.query<Row>(
    `SELECT m.tenant_id, m.role FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id
     WHERE m.user_id = $1 AND m.active AND t.status = 'active' ORDER BY t.name`, [userId]);
  return r.rows.map((x) => ({ tenantId: x.tenant_id as string, role: x.role as TenantRole }));
}

/** El rol del usuario en un local concreto (null si no pertenece o está inactivo): base de toda autorización de la API. */
export async function roleIn(tx: Queryable, userId: string, tenantId: string): Promise<TenantRole | null> {
  return (await membershipsOf(tx, userId)).find((m) => m.tenantId === tenantId)?.role ?? null;
}
