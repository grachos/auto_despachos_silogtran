// Static API key check (header x-api-key), constant-time comparison.
import { timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors.js';

export function requireApiKey(req) {
  const expected = process.env.API_KEY;
  if (!expected) throw new ApiError('CONFIG_MISSING', 'Falta configurar API_KEY en el servidor.', { status: 500 });
  const given = Buffer.from(String(req.headers['x-api-key'] || ''));
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    throw new ApiError('UNAUTHORIZED', 'API key inválida o ausente (header x-api-key).', { status: 401 });
  }
}
