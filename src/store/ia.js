// Persistence for the WhatsApp assistant: short chat history, pending dispatches (token stays server-side) and usage counters.
import { supabase } from './supabase.js';
import { ApiError } from '../http/errors.js';

export const PENDING_TTL_MS = 15 * 60_000;

const fail = (e) => new ApiError('STORE_FAILED', 'No se pudo leer o guardar en Supabase.', { status: 500, detail: e?.message || String(e) });
const run = async (q) => {
  const { data, error } = await q;
  if (error) throw fail(error);
  return data;
};

export async function addMessage(userId, role, content) {
  await run(supabase().from('ia_mensajes').insert({ user_id: userId, role, content: String(content).slice(0, 2000) }));
}

// Last few turns (ascending) from the last hours only: enough for "ah, el BL es..." without growing the prompt.
export async function recentHistory(userId, limit = 10, hours = 3) {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const rows = await run(supabase().from('ia_mensajes').select('role, content').eq('user_id', userId).gt('created_at', since).order('created_at', { ascending: false }).limit(limit));
  return rows.reverse();
}

export const pruneOld = (userId) =>
  run(supabase().from('ia_mensajes').delete().eq('user_id', userId).lt('created_at', new Date(Date.now() - 3 * 86_400_000).toISOString()));

// Creates the pending row; any older PENDING of the same user is superseded (only the latest button set is live).
export async function createPending(userId, { numero, token, resumen, anticipo }) {
  const db = supabase();
  await run(db.from('ia_pendientes').update({ status: 'SUPERSEDED' }).eq('user_id', userId).eq('status', 'PENDING'));
  const row = await run(
    db.from('ia_pendientes').insert({ user_id: userId, numero, token, resumen, anticipo_sugerido: anticipo, expires_at: new Date(Date.now() + PENDING_TTL_MS).toISOString() }).select('id').single(),
  );
  return row.id;
}

export const getPending = (id) => run(supabase().from('ia_pendientes').select('*').eq('id', id).maybeSingle());

export async function latestPending(userId) {
  const rows = await run(
    supabase().from('ia_pendientes').select('*').eq('user_id', userId).eq('status', 'PENDING').gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1),
  );
  return rows[0] ?? null;
}

// Atomic: only one tap wins; returns the row (with the token) or null.
export async function claimPending(id, userId) {
  const rows = await run(
    supabase().from('ia_pendientes').update({ status: 'PROCESSING' }).eq('id', id).eq('user_id', userId).eq('status', 'PENDING').gt('expires_at', new Date().toISOString()).select('*'),
  );
  return rows[0] ?? null;
}

export const finishPending = (id, status) => run(supabase().from('ia_pendientes').update({ status }).eq('id', id).eq('status', 'PROCESSING'));

export async function cancelPending(id, userId) {
  const rows = await run(supabase().from('ia_pendientes').update({ status: 'CANCELLED' }).eq('id', id).eq('user_id', userId).eq('status', 'PENDING').select('id'));
  return rows.length === 1;
}

// Why a pressed button is not usable (null = usable).
export function pendingProblem(row, userId, now = Date.now()) {
  if (!row || row.user_id !== userId) return 'NOT_FOUND'; // same answer for "foreign": never reveal other users' rows
  if (row.status === 'PROCESSING') return 'PROCESSING';
  if (row.status === 'USED') return 'USED';
  if (row.status === 'CANCELLED') return 'CANCELLED';
  if (row.status === 'SUPERSEDED') return 'SUPERSEDED';
  if (new Date(row.expires_at).getTime() <= now) return 'EXPIRED';
  return null;
}

export async function usageCount(userId, kind, sinceMs = 3600_000) {
  const since = new Date(Date.now() - sinceMs).toISOString();
  return (await run(supabase().from('ia_uso').select('id').eq('user_id', userId).eq('kind', kind).gt('created_at', since))).length;
}
export const recordUsage = (userId, kind) => run(supabase().from('ia_uso').insert({ user_id: userId, kind }));
