// Persists the Silogtran cookie jar in Supabase so serverless invocations reuse the session.
import { supabase } from './supabase.js';
import { ApiError } from '../http/errors.js';

const TABLE = 'silog_session';
const ID = 'default';

function storeError(e) {
  return new ApiError('SESSION_STORE_FAILED', 'No se pudo leer o guardar la sesión en Supabase.', {
    status: 500,
    detail: e?.message || String(e),
  });
}

export async function loadCookies() {
  const { data, error } = await supabase().from(TABLE).select('cookies').eq('id', ID).maybeSingle();
  if (error) throw storeError(error);
  return data?.cookies || null;
}

export async function saveCookies(cookies) {
  const { error } = await supabase()
    .from(TABLE)
    .upsert({ id: ID, cookies, updated_at: new Date().toISOString() });
  if (error) throw storeError(error);
}
