import { createHash, createHmac, randomInt } from 'node:crypto';

/**
 * Token de retiro por parte de pedido.
 * Es una firma HMAC (clave del servidor) sobre local+parte, así el cliente puede volver a mostrar su QR
 * sin que el servidor guarde el token en claro: en la base solo queda su hash (ver ADR 0005, enmienda).
 * Un solo uso: lo garantiza la base de datos (used_at), no el token.
 */
export function makePickupToken(secret: string, tenantId: string, partId: string): string {
  return createHmac('sha256', secret).update(`pickup:${tenantId}:${partId}`).digest('base64url');
}

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

// Sin caracteres ambiguos (0/O, 1/I/L): el código se dicta o se tipea en el mostrador.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function makeShortCode(length = 4): string {
  return Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
}
