// Persistence of batch drafts (M7). Only the latest DRAFT of a user is live.
import { supabase } from './supabase.js';
import { ApiError } from '../http/errors.js';

export const LOTE_TTL_MS = 60 * 60_000;

const fail = (e) => new ApiError('STORE_FAILED', 'No se pudo leer o guardar en Supabase.', { status: 500, detail: e?.message || String(e) });
const run = async (q) => {
  const { data, error } = await q;
  if (error) throw fail(error);
  return data;
};

export async function createLote(userId, { filas, texto }) {
  const db = supabase();
  await run(db.from('ia_lotes').update({ status: 'SUPERSEDED' }).eq('user_id', userId).eq('status', 'DRAFT'));
  const row = await run(
    db.from('ia_lotes').insert({ user_id: userId, filas, texto: String(texto ?? '').slice(0, 4000), expires_at: new Date(Date.now() + LOTE_TTL_MS).toISOString() }).select('id').single(),
  );
  return row.id;
}
