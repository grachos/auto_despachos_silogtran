// Mutex per Silogtran cookie jar (key = user id, or 'default' for user zero). Two flows on the same jar would
// corrupt each other: both could re-login (replacing PHPSESSID mid-flow) and "Quitar Todos" would wipe the
// other's pending item. The lock has an owner token and a TTL longer than the function's max duration.
import { randomUUID } from 'node:crypto';
import { supabase } from './supabase.js';
import { ApiError } from '../http/errors.js';

const TABLE = 'silog_locks';
export const LOCK_TTL_MS = 90_000;

const fail = (e) => new ApiError('STORE_FAILED', 'No se pudo tomar el bloqueo de la sesión.', { status: 500, detail: e?.message || String(e) });

// Returns an owner token, or null if another flow holds a live lock.
export async function acquireLock(key, ttlMs = LOCK_TTL_MS) {
  const db = supabase();
  const token = randomUUID();
  const expires = new Date(Date.now() + ttlMs).toISOString();
  const ins = await db.from(TABLE).insert({ key, token, expires_at: expires });
  if (!ins.error) return token;
  if (ins.error.code !== '23505') throw fail(ins.error);
  // Someone holds it: take it over only if it already expired (crashed/timed-out owner).
  const re = await db.from(TABLE).update({ token, expires_at: expires }).eq('key', key).lt('expires_at', new Date().toISOString()).select('key');
  if (re.error) throw fail(re.error);
  return re.data.length === 1 ? token : null;
}

export async function releaseLock(key, token) {
  const { error } = await supabase().from(TABLE).delete().eq('key', key).eq('token', token);
  if (error) throw fail(error);
}

const real = { acquire: acquireLock, release: releaseLock };

export async function withLock(key, fn, impl = real) {
  const token = await impl.acquire(key);
  if (!token) throw new ApiError('USER_BUSY', 'Ya hay un despacho en curso para este usuario; intenta de nuevo en un momento.', { status: 409 });
  try {
    return await fn();
  } finally {
    await impl.release(key, token).catch((e) => console.error('[lock] release failed:', e?.code || 'error'));
  }
}
