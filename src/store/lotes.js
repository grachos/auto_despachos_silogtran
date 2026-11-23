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

const now = () => new Date().toISOString();

export async function getLote(id) {
  return (await run(supabase().from('ia_lotes').select('*').eq('id', id).maybeSingle())) ?? null;
}

// DRAFT -> PREPARING, atomically (a double tap starts it once). Supersedes the user's older batches and their pending confirmations,
// and creates one item per valid row. Returns the lote row or null (not yours / not a draft / expired).
export async function startLote(id, userId, phone) {
  const db = supabase();
  const rows = await run(
    db.from('ia_lotes').update({ status: 'PREPARING', phone, updated_at: now() }).eq('id', id).eq('user_id', userId).eq('status', 'DRAFT').gt('expires_at', now()).select('*'),
  );
  const lote = rows[0];
  if (!lote) return null;
  await run(db.from('ia_lotes').update({ status: 'SUPERSEDED' }).eq('user_id', userId).in('status', ['PREPARING', 'READY']).neq('id', id));
  await run(db.from('ia_pendientes').update({ status: 'SUPERSEDED' }).eq('user_id', userId).eq('status', 'PENDING').not('lote_id', 'is', null).neq('lote_id', id));
  const items = (lote.filas ?? []).map((f, i) => ({ lote_id: id, n: i + 1, numero: String(f.numero), input: f.input }));
  await run(db.from('ia_lote_items').insert(items));
  return lote;
}

export const listItems = (loteId) => run(supabase().from('ia_lote_items').select('*').eq('lote_id', loteId).order('n', { ascending: true }));

export async function nextPendingItem(loteId) {
  const rows = await run(supabase().from('ia_lote_items').select('n, attempts').eq('lote_id', loteId).eq('status', 'PENDING').order('n', { ascending: true }).limit(1));
  return rows[0] ?? null;
}

// Atomic claim of one item (PENDING -> PREPARING, attempts + 1). Null when someone else already took it or it is done.
export async function claimItem(loteId, n) {
  const cur = (await run(supabase().from('ia_lote_items').select('*').eq('lote_id', loteId).eq('n', n).eq('status', 'PENDING').maybeSingle())) ?? null;
  if (!cur) return null;
  const rows = await run(
    supabase().from('ia_lote_items').update({ status: 'PREPARING', attempts: cur.attempts + 1, updated_at: now() }).eq('id', cur.id).eq('status', 'PENDING').eq('attempts', cur.attempts).select('*'),
  );
  return rows[0] ?? null;
}

export const finishItem = (loteId, n, patch) =>
  run(supabase().from('ia_lote_items').update({ ...patch, updated_at: now() }).eq('lote_id', loteId).eq('n', n).eq('status', 'PREPARING'));
export const releaseItem = (loteId, n) => finishItem(loteId, n, { status: 'PENDING' });

export const setLoteStatus = (id, status, from) => {
  let q = supabase().from('ia_lotes').update({ status, updated_at: now() }).eq('id', id);
  if (from) q = q.in('status', [].concat(from));
  return run(q);
};

// Cancels a batch of the user: nothing left to prepare, and its prepared confirmations stop being usable.
export async function cancelLote(id, userId) {
  const db = supabase();
  const rows = await run(db.from('ia_lotes').update({ status: 'CANCELLED', updated_at: now() }).eq('id', id).eq('user_id', userId).in('status', ['DRAFT', 'PREPARING', 'READY']).select('id'));
  if (!rows.length) return false;
  await run(db.from('ia_lote_items').update({ status: 'CANCELLED', updated_at: now() }).eq('lote_id', id).eq('status', 'PENDING'));
  await run(db.from('ia_pendientes').update({ status: 'CANCELLED' }).eq('lote_id', id).eq('status', 'PENDING'));
  return true;
}

export const getPendingsByIds = (ids) => (ids.length ? run(supabase().from('ia_pendientes').select('id, resumen, expires_at, status').in('id', ids)) : Promise.resolve([]));

// Safety net for a batch cancelled while a row was being prepared: its late confirmations must not stay usable.
export const cancelLotePendings = (loteId) => run(supabase().from('ia_pendientes').update({ status: 'CANCELLED' }).eq('lote_id', loteId).eq('status', 'PENDING'));

// Rows that will not be prepared (the chain could not continue): shown as rejected with the reason.
export const rejectPendingItems = (loteId, code, text) =>
  run(supabase().from('ia_lote_items').update({ status: 'REJECTED', error_code: code, error_text: text, updated_at: now() }).eq('lote_id', loteId).eq('status', 'PENDING'));
