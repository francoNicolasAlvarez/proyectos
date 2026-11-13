import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Cifrado AES-256-GCM para credenciales de proveedores (tokens OAuth de cada local). Formato: v1.iv.tag.datos (base64url). */
export function encryptSecret(plain: string, key: Buffer): string {
  if (key.length !== 32) throw new Error('La clave de cifrado debe tener 32 bytes');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function decryptSecret(boxed: string, key: Buffer): string {
  const [v, iv, tag, data] = boxed.split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Formato de secreto inválido');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}
