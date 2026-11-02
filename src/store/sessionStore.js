// Persists the Silogtran cookie jar in Supabase (one row per app user) so serverless invocations reuse the session.
import { supabase } from './supabase.js';
import { ApiError } from '../http/errors.js';

const TABLE = 'silog_session';
export const DEFAULT_USER_ID = 'default';

function storeError(e) {
  return new ApiError('SESSION_STORE_FAILED', 'No se pudo leer o guardar la sesión en Supabase.', {
    status: 500,
    detail: e?.message || String(e),
  });
}

export async function loadCookies(userId = DEFAULT_USER_ID) {
  const { data, error } = await supabase().from(TABLE).select('cookies').eq('id', userId).maybeSingle();
  if (error) throw storeError(error);
  return data?.cookies || null;
}

export async function saveCookies(cookies, userId = DEFAULT_USER_ID) {
  const { error } = await supabase()
    .from(TABLE)
    .upsert({ id: userId, cookies, updated_at: new Date().toISOString() });
  if (error) throw storeError(error);
}
