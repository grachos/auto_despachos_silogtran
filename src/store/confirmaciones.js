// Idempotency + per-request lock for `confirmar`, persisted in Supabase.
// States: PROCESSING (in flight) -> DONE | FAILED (nothing saved, safe to retry) | UNKNOWN (may have saved).
import { supabase } from './supabase.js';
import { ApiError } from '../http/errors.js';

const TABLE = 'silog_confirmaciones';
const STALE_MS = 3 * 60 * 1000; // a PROCESSING row older than this is treated as UNKNOWN (function died)

const fail = (e) => new ApiError('SESSION_STORE_FAILED', 'No se pudo leer o guardar la confirmación en Supabase.', { status: 500, detail: e?.message || String(e) });
const locked = (numero) => new ApiError('SOLICITUD_LOCKED', `La solicitud ${numero} ya está siendo confirmada; espera a que termine.`, { status: 409 });

// Returns { state: 'CLAIMED' } or { state: 'DONE', result } / { state: 'UNKNOWN' } / throws.
export async function claimConfirmation(tokenId, numero) {
  const db = supabase();
  const stale = await db.from(TABLE).update({ status: 'UNKNOWN', detail: 'stale PROCESSING' }).eq('status', 'PROCESSING').lt('updated_at', new Date(Date.now() - STALE_MS).toISOString());
  if (stale.error) throw fail(stale.error);

  const ins = await db.from(TABLE).insert({ token_id: tokenId, numero, status: 'PROCESSING' });
  if (!ins.error) return { state: 'CLAIMED' };
  if (ins.error.code !== '23505') throw fail(ins.error);

  const { data, error } = await db.from(TABLE).select('status, result').eq('token_id', tokenId).maybeSingle();
  if (error) throw fail(error);
  if (!data) throw locked(numero); // unique violation came from the per-request lock
  if (data.status === 'DONE') return { state: 'DONE', result: data.result };
  if (data.status === 'PROCESSING') throw new ApiError('CONFIRMATION_IN_PROGRESS', 'Esta confirmación ya está en proceso.', { status: 409 });
  if (data.status === 'UNKNOWN') return { state: 'UNKNOWN' };

  // FAILED: nothing was saved, so the same token may be retried (atomic re-claim).
  const re = await db.from(TABLE).update({ status: 'PROCESSING', updated_at: new Date().toISOString() }).eq('token_id', tokenId).eq('status', 'FAILED').select('token_id');
  if (re.error) {
    if (re.error.code === '23505') throw locked(numero);
    throw fail(re.error);
  }
  if (!re.data?.length) throw new ApiError('CONFIRMATION_IN_PROGRESS', 'Esta confirmación ya está en proceso.', { status: 409 });
  return { state: 'CLAIMED' };
}

export async function markConfirmation(tokenId, status, { result, detail } = {}) {
  const patch = { status, updated_at: new Date().toISOString() };
  if (result !== undefined) patch.result = result;
  if (detail !== undefined) patch.detail = String(detail).slice(0, 500);
  const { error } = await supabase().from(TABLE).update(patch).eq('token_id', tokenId);
  if (error) console.error('[markConfirmation]', error.message);
}
