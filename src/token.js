// Stateless signed token (HMAC-SHA256) carrying the `preparar` inputs so `confirmar` can redo the fill.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from './http/errors.js';

const secret = () => {
  const s = process.env.TOKEN_SECRET;
  if (!s || s.length < 16) throw new ApiError('CONFIG_MISSING', 'Falta configurar TOKEN_SECRET (mínimo 16 caracteres) en el servidor.', { status: 500 });
  return s;
};
export const assertTokenSecret = () => void secret();
const sign = (body) => createHmac('sha256', secret()).update(body).digest('base64url');

export function signToken(payload, ttlSec = 900, typ = 'preparar') {
  const body = Buffer.from(JSON.stringify({ ...payload, typ, exp: Math.floor(Date.now() / 1000) + ttlSec })).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function verifyToken(token, typ = 'preparar') {
  const [body, sig] = String(token || '').split('.');
  const expected = body ? sign(body) : '';
  if (!body || !sig || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new ApiError('TOKEN_INVALID', 'El token es inválido; vuelve a ejecutar preparar.', { status: 400 });
  }
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (payload.typ !== typ) throw new ApiError('TOKEN_INVALID', 'El token no es válido para esta operación.', { status: 400 });
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw new ApiError('TOKEN_EXPIRED', 'El token expiró; vuelve a ejecutar preparar.', { status: 410 });
  }
  return payload;
}

// Reads the payload of a token WITHOUT verifying signature/expiry. Only for tokens loaded from our own database
// (e.g. to re-prepare an expired summary); never use it on tokens received from outside.
export function peekToken(token) {
  try {
    return JSON.parse(Buffer.from(String(token || '').split('.')[0], 'base64url').toString());
  } catch {
    return null;
  }
}
