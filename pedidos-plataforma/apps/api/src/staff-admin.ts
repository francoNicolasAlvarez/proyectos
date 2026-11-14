/**
 * Equipo del local: quién trabaja y con qué rol. Solo el dueño.
 * Invariante central: un local siempre conserva al menos un dueño activo (si no, nadie podría administrarlo).
 */
import type { TenantRole } from '@pasamanos/shared';
import { DomainError, type Queryable } from './db';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const ROLES: readonly TenantRole[] = ['owner', 'manager', 'order_operator', 'pickup_operator'];
export interface MemberView { userId: string; name: string; email: string; role: TenantRole; active: boolean }

const view = (r: Row): MemberView => ({ userId: r.user_id, name: r.name, email: r.email, role: r.role, active: r.active });

export async function listMembers(tx: Queryable, tenantId: string): Promise<MemberView[]> {
  // Se filtra por local de forma explícita: la política de membresías también deja ver las propias de otros locales.
  const r = await tx.query<Row>(
    `SELECT m.user_id, u.name, u.email, m.role, m.active FROM tenant_memberships m JOIN users u ON u.id = m.user_id
     WHERE m.tenant_id = $1 ORDER BY m.active DESC, m.role, u.name`, [tenantId]);
  return r.rows.map(view);
}

const audit = (tx: Queryable, p: { tenantId: string; actorUserId: string; action: string; targetUserId: string; before?: unknown; after?: unknown }) =>
  tx.query('INSERT INTO audit_log (tenant_id, actor_user_id, action, entity, entity_id, before, after) VALUES ($1,$2,$3,\'membership\',$4,$5,$6)',
    [p.tenantId, p.actorUserId, p.action, p.targetUserId, p.before === undefined ? null : JSON.stringify(p.before), p.after === undefined ? null : JSON.stringify(p.after)]);

/** Suma a una persona YA REGISTRADA como empleado. (La invitación por correo a quien no tiene cuenta queda para más adelante.) */
export async function addMember(tx: Queryable, p: { tenantId: string; actorUserId: string; email: string; role: TenantRole }): Promise<MemberView> {
  if (!ROLES.includes(p.role)) throw new DomainError('INVALID_ROLE');
  const u = (await tx.query<Row>("SELECT id, name, email, status FROM users WHERE lower(email) = $1", [p.email.trim().toLowerCase()])).rows[0];
  if (!u) throw new DomainError('USER_NOT_FOUND');
  if (u.status !== 'active') throw new DomainError('USER_BLOCKED');
  const cur = (await tx.query<Row>('SELECT role, active FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE', [p.tenantId, u.id])).rows[0];
  if (cur?.active) throw new DomainError('MEMBER_ALREADY_EXISTS');
  if (cur) await tx.query('UPDATE tenant_memberships SET role = $3, active = true WHERE tenant_id = $1 AND user_id = $2', [p.tenantId, u.id, p.role]);
  else await tx.query('INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)', [p.tenantId, u.id, p.role]);
  await audit(tx, { tenantId: p.tenantId, actorUserId: p.actorUserId, action: cur ? 'member.reactivated' : 'member.added', targetUserId: u.id, after: { role: p.role } });
  return view({ user_id: u.id, name: u.name, email: u.email, role: p.role, active: true });
}

export async function updateMember(tx: Queryable, p: { tenantId: string; actorUserId: string; userId: string; role?: TenantRole; active?: boolean }): Promise<MemberView> {
  if (p.role !== undefined && !ROLES.includes(p.role)) throw new DomainError('INVALID_ROLE');
  const cur = (await tx.query<Row>(
    `SELECT m.user_id, u.name, u.email, m.role, m.active FROM tenant_memberships m JOIN users u ON u.id = m.user_id
     WHERE m.tenant_id = $1 AND m.user_id = $2 FOR UPDATE OF m`, [p.tenantId, p.userId])).rows[0];
  if (!cur) throw new DomainError('MEMBER_NOT_FOUND');
  const role = p.role ?? cur.role;
  const active = p.active ?? cur.active;
  const losesOwner = cur.role === 'owner' && cur.active && (role !== 'owner' || !active);
  if (losesOwner) {
    const owners = Number((await tx.query<Row>("SELECT count(*)::int n FROM tenant_memberships WHERE tenant_id = $1 AND role = 'owner' AND active", [p.tenantId])).rows[0]?.n);
    if (owners <= 1) throw new DomainError('LAST_OWNER');
  }
  await tx.query('UPDATE tenant_memberships SET role = $3, active = $4 WHERE tenant_id = $1 AND user_id = $2', [p.tenantId, p.userId, role, active]);
  await audit(tx, { tenantId: p.tenantId, actorUserId: p.actorUserId, action: 'member.updated', targetUserId: p.userId, before: { role: cur.role, active: cur.active }, after: { role, active } });
  return view({ ...cur, role, active });
}
