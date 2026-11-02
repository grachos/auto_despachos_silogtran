// Required environment variables (values never logged).
import { ApiError } from './http/errors.js';

const REQUIRED = ['SILOG_USER', 'SILOG_PASSWORD', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];

export function requireConfig() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new ApiError('CONFIG_MISSING', `Faltan variables de entorno: ${missing.join(', ')}.`, { status: 500 });
  }
}
