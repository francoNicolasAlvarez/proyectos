import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { can } from '@pasamanos/shared';
import { authenticate, changePassword, hashPassword, login, logout, membershipsOf, normalizeEmail, registerUser, roleIn, verifyPassword } from '../src/auth';
import { withContext, type Database } from '../src/db';

const COST = 2 ** 10;   // barato para pruebas; en producción 2^15 (el costo viaja dentro del hash)
let pg: PGlite;
let db: Database;
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync(fileURLToPath(new URL('../db/migrations/0001_init.sql', import.meta.url)), 'utf8'));
  db = pg as unknown as Database;
});
const run = <T>(fn: Parameters<typeof withContext<T>>[2], ctx = { role: 'app_runtime' } as Parameters<typeof withContext>[1]) => withContext(db, ctx, fn);
const one = async (sql: string, p: unknown[] = []) => (await pg.query<Row>(sql, p)).rows[0] as Row;
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as { code?: string }).code ?? (e as Error).message; } return null; };
let n = 0;
const reg = (over: Partial<Parameters<typeof registerUser>[1]> = {}) =>
  run((tx) => registerUser(tx, { email: `u${++n}@mail.com`, name: 'Ana', password: 'una-clave-larga', adultDeclared: true, cost: COST, ...over }));

describe('contraseñas', () => {
  it('se guardan con scrypt, salt aleatorio y se verifican', async () => {
    const h = await hashPassword('secreto-123', COST);
    expect(h).toMatch(/^scrypt\$1024\$8\$1\$/);
    expect(h).not.toContain('secreto-123');
    expect(await hashPassword('secreto-123', COST)).not.toBe(h);
    expect(await verifyPassword('secreto-123', h)).toBe(true);
    expect(await verifyPassword('secreto-124', h)).toBe(false);
    expect(await verifyPassword('x', 'formato-roto')).toBe(false);
  });
});

describe('registro', () => {
  it('crea la cuenta con la declaración de mayoría de edad y email normalizado', async () => {
    const { userId } = await reg({ email: '  Ana.Perez@Mail.COM ' });
    const u = await one('SELECT email, adult_declared_at, password_hash FROM users WHERE id=$1', [userId]);
    expect(u.email).toBe('ana.perez@mail.com');
    expect(u.adult_declared_at).not.toBeNull();
    expect(u.password_hash).not.toContain('una-clave');
    expect(normalizeEmail(' X@Y.com ')).toBe('x@y.com');
  });

  it('no permite emails repetidos (sin distinguir mayúsculas)', async () => {
    const a = await reg({ email: 'dup@mail.com' });
    expect(a.userId).toBeTruthy();
    expect(await code(reg({ email: 'DUP@mail.com' }))).toBe('EMAIL_TAKEN');
  });

  it.each([
    ['email inválido', { email: 'no-es-email' }, 'INVALID_EMAIL'],
    ['sin declaración de edad', { adultDeclared: false }, 'ADULT_DECLARATION_REQUIRED'],
    ['contraseña corta', { password: '1234567' }, 'PASSWORD_TOO_SHORT'],
    ['contraseña enorme', { password: 'a'.repeat(129) }, 'PASSWORD_TOO_LONG'],
    ['sin nombre', { name: '  ' }, 'NAME_REQUIRED'],
  ])('rechaza: %s', async (_n, over, expected) => { expect(await code(reg(over))).toBe(expected); });

  it('la contraseña no puede ser el email', async () => {
    expect(await code(reg({ email: 'igual@mail.com', password: 'igual@mail.com' }))).toBe('PASSWORD_SAME_AS_EMAIL');
  });
});

describe('sesiones', () => {
  it('inicia sesión, autentica con el token y no guarda el token en claro', async () => {
    const { userId } = await reg({ email: 'ses@mail.com' });
    const s = await run((tx) => login(tx, { email: 'SES@mail.com', password: 'una-clave-larga', cost: COST }));
    expect(s.userId).toBe(userId);
    expect(await run((tx) => authenticate(tx, s.token))).toMatchObject({ id: userId, isPlatformAdmin: false });
    expect((await one('SELECT token_hash FROM sessions WHERE user_id=$1', [userId])).token_hash).not.toContain(s.token);
  });

  it('el mismo error para email inexistente y contraseña errónea', async () => {
    await reg({ email: 'x1@mail.com' });
    expect(await code(run((tx) => login(tx, { email: 'x1@mail.com', password: 'incorrecta-123', cost: COST })))).toBe('INVALID_CREDENTIALS');
    expect(await code(run((tx) => login(tx, { email: 'nadie@mail.com', password: 'incorrecta-123', cost: COST })))).toBe('INVALID_CREDENTIALS');
  });

  it('cuentas bloqueadas no pueden entrar ni usar sesiones existentes', async () => {
    const { userId } = await reg({ email: 'blk@mail.com' });
    const s = await run((tx) => login(tx, { email: 'blk@mail.com', password: 'una-clave-larga', cost: COST }));
    await pg.query("UPDATE users SET status='blocked' WHERE id=$1", [userId]);
    expect(await code(run((tx) => login(tx, { email: 'blk@mail.com', password: 'una-clave-larga', cost: COST })))).toBe('ACCOUNT_BLOCKED');
    expect(await run((tx) => authenticate(tx, s.token))).toBeNull();
  });

  it('cerrar sesión la revoca de inmediato; tokens falsos, vacíos o vencidos no autentican', async () => {
    await reg({ email: 'out@mail.com' });
    const s = await run((tx) => login(tx, { email: 'out@mail.com', password: 'una-clave-larga', cost: COST }));
    await run((tx) => logout(tx, s.token));
    expect(await run((tx) => authenticate(tx, s.token))).toBeNull();
    expect(await run((tx) => authenticate(tx, 'token-falso'))).toBeNull();
    expect(await run((tx) => authenticate(tx, undefined))).toBeNull();
    const s2 = await run((tx) => login(tx, { email: 'out@mail.com', password: 'una-clave-larga', cost: COST }));
    await pg.query("UPDATE sessions SET expires_at = now() - interval '1 minute'");
    expect(await run((tx) => authenticate(tx, s2.token))).toBeNull();
  });

  it('cambiar la contraseña cierra las demás sesiones y conserva la actual', async () => {
    const { userId } = await reg({ email: 'chg@mail.com' });
    const a = await run((tx) => login(tx, { email: 'chg@mail.com', password: 'una-clave-larga', cost: COST }));
    const b = await run((tx) => login(tx, { email: 'chg@mail.com', password: 'una-clave-larga', cost: COST }));
    expect(await code(run((tx) => changePassword(tx, { userId, current: 'equivocada-1', next: 'nueva-clave-segura', cost: COST })))).toBe('INVALID_CREDENTIALS');
    await run((tx) => changePassword(tx, { userId, current: 'una-clave-larga', next: 'nueva-clave-segura', keepToken: a.token, cost: COST }));
    expect(await run((tx) => authenticate(tx, a.token))).not.toBeNull();
    expect(await run((tx) => authenticate(tx, b.token))).toBeNull();
    await run((tx) => login(tx, { email: 'chg@mail.com', password: 'nueva-clave-segura', cost: COST }));
    expect(await code(run((tx) => login(tx, { email: 'chg@mail.com', password: 'una-clave-larga', cost: COST })))).toBe('INVALID_CREDENTIALS');
  });
});

describe('roles por local', () => {
  it('cada usuario ve solo sus membresías activas y el rol decide las acciones', async () => {
    const a = (await one("INSERT INTO tenants (name, slug) VALUES ('Bar A','bar-a') RETURNING id")).id;
    const b = (await one("INSERT INTO tenants (name, slug) VALUES ('Bar B','bar-b') RETURNING id")).id;
    const gone = (await one("INSERT INTO tenants (name, slug, status) VALUES ('Cerrado','cerrado','suspended') RETURNING id")).id;
    const { userId } = await reg({ email: 'staff@mail.com' });
    const other = await reg({ email: 'otro@mail.com' });
    await pg.query("INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1,$2,'manager'),($3,$2,'pickup_operator'),($4,$2,'owner')", [a, userId, b, gone]);
    await pg.query("INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1,$2,'owner')", [a, other.userId]);

    const ctx = { userId, role: 'app_runtime' };
    const list = await run((tx) => membershipsOf(tx, userId), ctx);
    expect(list).toEqual([{ tenantId: a, role: 'manager' }, { tenantId: b, role: 'pickup_operator' }]);   // sin locales suspendidos

    const roleA = await run((tx) => roleIn(tx, userId, a), ctx);
    const roleB = await run((tx) => roleIn(tx, userId, b), ctx);
    expect(can(roleA, 'catalog.manage')).toBe(true);
    expect(can(roleA, 'staff.manage')).toBe(false);
    expect(can(roleB, 'orders.deliver')).toBe(true);
    expect(can(roleB, 'orders.process')).toBe(false);
    expect(await run((tx) => roleIn(tx, userId, gone), ctx)).toBeNull();

    // el contexto de otro usuario no revela membresías ajenas
    expect(await run((tx) => membershipsOf(tx, userId), { userId: other.userId, role: 'app_runtime' })).toEqual([]);
    // inactiva → sin rol
    await pg.query('UPDATE tenant_memberships SET active=false WHERE tenant_id=$1 AND user_id=$2', [a, userId]);
    expect(await run((tx) => roleIn(tx, userId, a), ctx)).toBeNull();
  });
});
