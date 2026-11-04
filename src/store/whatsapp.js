// Persistence for the WhatsApp webhook: dedupe, link codes, phone <-> user link, failed-attempt limiter.
import { supabase } from './supabase.js';
import { ApiError } from '../http/errors.js';
import { codeHash } from './vinculacion.js';

export const MAX_FAILED_PER_HOUR = 5;

const fail = (e) => new ApiError('STORE_FAILED', 'No se pudo leer o guardar en Supabase.', { status: 500, detail: e?.message || String(e) });
const run = async (q) => {
  const { data, error } = await q;
  if (error) throw Object.assign(fail(error), { pgCode: error.code });
  return data;
};

// true the first time a message id is seen, false for a duplicate delivery.
export async function markSeen(messageId) {
  const { error } = await supabase().from('whatsapp_mensajes').insert({ message_id: messageId });
  if (!error) return true;
  if (error.code === '23505') return false;
  throw fail(error);
}
export const unmarkSeen = (messageId) => run(supabase().from('whatsapp_mensajes').delete().eq('message_id', messageId));

export async function getLinkByPhone(phone) {
  const row = await run(supabase().from('vinculos_whatsapp').select('user_id, app_users(nombre, status, relink_required)').eq('phone', phone).maybeSingle());
  return row ? { userId: row.user_id, nombre: row.app_users?.nombre ?? '', status: row.app_users?.relink_required ? 'NEEDS_RELINK' : row.app_users?.status } : null;
}

// Marks the code used (atomic: only one caller wins) and returns the owner's user id, or null.
export async function consumeCode(code) {
  const rows = await run(
    supabase().from('codigos_vinculacion').update({ used_at: new Date().toISOString() }).eq('code_hash', codeHash(code))
      .is('used_at', null).gt('expires_at', new Date().toISOString()).select('user_id'),
  );
  return rows.length === 1 ? rows[0].user_id : null;
}

// Last link wins: a phone belongs to one account and an account to one phone.
export async function linkPhone(userId, phone) {
  const db = supabase();
  await run(db.from('vinculos_whatsapp').delete().eq('phone', phone));
  await run(db.from('vinculos_whatsapp').delete().eq('user_id', userId));
  await run(db.from('vinculos_whatsapp').insert({ user_id: userId, phone }));
}

export async function unlinkPhone(phone) {
  const rows = await run(supabase().from('vinculos_whatsapp').delete().eq('phone', phone).select('user_id'));
  return rows.length > 0;
}

export async function failedAttempts(phone) {
  const since = new Date(Date.now() - 3600_000).toISOString();
  return (await run(supabase().from('whatsapp_intentos').select('id').eq('phone', phone).gt('created_at', since))).length;
}
export const recordFail = (phone) => run(supabase().from('whatsapp_intentos').insert({ phone }));

export async function getPhoneByUser(userId) {
  const row = await run(supabase().from('vinculos_whatsapp').select('phone').eq('user_id', userId).maybeSingle());
  return row?.phone ?? null;
}
