// Required environment variables (values never logged).
import { ApiError } from './http/errors.js';

const REQUIRED = ['SILOG_USER', 'SILOG_PASSWORD', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];

export function requireConfig() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new ApiError('CONFIG_MISSING', `Faltan variables de entorno: ${missing.join(', ')}.`, { status: 500 });
  }
}

// Check an explicit list of env vars (new multi-user endpoints don't need the user-zero Silogtran creds).
export function requireEnv(...keys) {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new ApiError('CONFIG_MISSING', `Faltan variables de entorno: ${missing.join(', ')}.`, { status: 500 });
  }
}
