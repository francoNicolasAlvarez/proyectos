/**
 * Sectores de origen (mesa, barra, VIP, patio…) y sus códigos QR. El QR solo precarga el ORIGEN del pedido
 * (informativo): no da ninguna autorización, así que un QR filtrado solo genera un dato de origen equivocado.
 * Aun así se puede rotar (invalidar) cuando un QR se filtra o se reemplaza el cartel.
 */
import QRCode from 'qrcode';
import { DomainError, type Queryable } from './db';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type LocationKind = 'table' | 'bar' | 'sector' | 'other';
export interface LocationView { id: string; name: string; kind: LocationKind; active: boolean; qrUrl: string }

const view = (r: Row, qrUrl: (token: string) => string): LocationView => ({ id: r.id, name: r.name, kind: r.kind, active: r.active, qrUrl: qrUrl(r.qr_token) });

/** Dirección que codifica el QR: la app web del cliente, ya en el local y con el sector precargado. */
export const qrUrlFor = (appBaseUrl: string, slug: string) => (token: string) => `${appBaseUrl.replace(/\/$/, '')}/v/${encodeURIComponent(slug)}?s=${token}`;

export async function listLocations(tx: Queryable, tenantId: string, qrUrl: (t: string) => string): Promise<LocationView[]> {
  const r = await tx.query<Row>('SELECT id, name, kind, active, qr_token FROM locations WHERE tenant_id = $1 AND event_id IS NULL ORDER BY name', [tenantId]);
  return r.rows.map((x) => view(x, qrUrl));
}

export async function createLocation(tx: Queryable, p: { tenantId: string; name: string; kind: LocationKind; actorUserId: string }, qrUrl: (t: string) => string): Promise<LocationView> {
  const name = p.name.trim();
  if (!name) throw new DomainError('NAME_REQUIRED');
  const dup = await tx.query('SELECT 1 FROM locations WHERE tenant_id = $1 AND event_id IS NULL AND lower(name) = lower($2) AND active', [p.tenantId, name]);
  if (dup.rows.length) throw new DomainError('LOCATION_NAME_TAKEN');
  const r = (await tx.query<Row>('INSERT INTO locations (tenant_id, name, kind) VALUES ($1,$2,$3) RETURNING id, name, kind, active, qr_token', [p.tenantId, name, p.kind])).rows[0] as Row;
  await tx.query("INSERT INTO audit_log (tenant_id, actor_user_id, action, entity, entity_id, after) VALUES ($1,$2,'location.created','location',$3,$4)", [p.tenantId, p.actorUserId, r.id, JSON.stringify({ name, kind: p.kind })]);
  return view(r, qrUrl);
}

export async function updateLocation(tx: Queryable, p: { tenantId: string; id: string; name?: string; active?: boolean; actorUserId: string }, qrUrl: (t: string) => string): Promise<LocationView> {
  const cur = (await tx.query<Row>('SELECT id, name, kind, active, qr_token FROM locations WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [p.tenantId, p.id])).rows[0];
  if (!cur) throw new DomainError('LOCATION_NOT_FOUND');
  const name = p.name === undefined ? cur.name : p.name.trim();
  if (!name) throw new DomainError('NAME_REQUIRED');
  const active = p.active ?? cur.active;
  await tx.query('UPDATE locations SET name = $3, active = $4 WHERE tenant_id = $1 AND id = $2', [p.tenantId, p.id, name, active]);
  await tx.query("INSERT INTO audit_log (tenant_id, actor_user_id, action, entity, entity_id, before, after) VALUES ($1,$2,'location.updated','location',$3,$4,$5)",
    [p.tenantId, p.actorUserId, p.id, JSON.stringify({ name: cur.name, active: cur.active }), JSON.stringify({ name, active })]);
  return view({ ...cur, name, active }, qrUrl);
}

/** Invalida el QR impreso y emite uno nuevo (por si se filtró o se cambia el cartel). */
export async function rotateLocationQr(tx: Queryable, p: { tenantId: string; id: string; actorUserId: string }, qrUrl: (t: string) => string): Promise<LocationView> {
  const r = (await tx.query<Row>(
    "UPDATE locations SET qr_token = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') WHERE tenant_id = $1 AND id = $2 RETURNING id, name, kind, active, qr_token", [p.tenantId, p.id])).rows[0];
  if (!r) throw new DomainError('LOCATION_NOT_FOUND');
  await tx.query("INSERT INTO audit_log (tenant_id, actor_user_id, action, entity, entity_id) VALUES ($1,$2,'location.qr_rotated','location',$3)", [p.tenantId, p.actorUserId, p.id]);
  return view(r, qrUrl);
}

export async function locationQrSvg(tx: Queryable, tenantId: string, id: string, qrUrl: (t: string) => string): Promise<string> {
  const r = (await tx.query<Row>('SELECT qr_token FROM locations WHERE tenant_id = $1 AND id = $2', [tenantId, id])).rows[0];
  if (!r) throw new DomainError('LOCATION_NOT_FOUND');
  return QRCode.toString(qrUrl(r.qr_token), { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
}

/** Resolución pública de un QR escaneado: devuelve el sector (solo si está activo) para precargar el origen del pedido. */
export async function resolveLocationByToken(tx: Queryable, tenantId: string, token: string): Promise<{ id: string; name: string } | null> {
  const r = (await tx.query<Row>('SELECT id, name FROM locations WHERE tenant_id = $1 AND qr_token = $2 AND active AND event_id IS NULL', [tenantId, token])).rows[0];
  return r ? { id: r.id, name: r.name } : null;
}
