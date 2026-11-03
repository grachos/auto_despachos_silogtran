// Static API key check (header x-api-key), constant-time comparison.
import { timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors.js';

export const requireApiKey = (req) => requireKey(req, 'API_KEY');

// Constant-time check of the x-api-key header against the secret in env var `envName`.
export function requireKey(req, envName) {
  const expected = process.env[envName];
  if (!expected) throw new ApiError('CONFIG_MISSING', `Falta configurar ${envName} en el servidor.`, { status: 500 });
  const given = Buffer.from(String(req.headers['x-api-key'] || ''));
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    throw new ApiError('UNAUTHORIZED', 'API key inválida o ausente (header x-api-key).', { status: 401 });
  }
}
