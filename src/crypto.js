// AES-256-GCM for secrets at rest (Silogtran passwords).
// Format: v1:<iv>:<tag>:<ciphertext> (base64url). AAD binds a ciphertext to its owner (the user id),
// so a value copied to another row fails to decrypt. ENCRYPTION_KEY = 64 hex chars (openssl rand -hex 32).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ApiError } from './http/errors.js';

function key() {
  const hex = process.env.ENCRYPTION_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new ApiError('CONFIG_MISSING', 'Falta configurar ENCRYPTION_KEY (64 caracteres hexadecimales) en el servidor.', { status: 500 });
  }
  return Buffer.from(hex, 'hex');
}

// Fail fast (before touching Silogtran) when the key is missing or malformed.
export const requireEncryptionKey = () => void key();

export function encrypt(plain, aad) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  c.setAAD(Buffer.from(String(aad)));
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join(':');
}

export function decrypt(blob, aad) {
  const [v, iv, tag, ct] = String(blob || '').split(':');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new ApiError('DECRYPT_FAILED', 'No se pudo descifrar el dato guardado.', { status: 500 });
  try {
    const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(String(aad)));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError('DECRYPT_FAILED', 'No se pudo descifrar el dato guardado.', { status: 500 });
  }
}
