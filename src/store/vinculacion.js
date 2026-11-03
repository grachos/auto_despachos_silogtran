// WhatsApp linking: one-time codes (stored only as HMAC) and the phone <-> user link.
import { createHmac, randomInt } from 'node:crypto';
import { supabase } from './supabase.js';
import { ApiError } from '../http/errors.js';

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_CODES_PER_HOUR = 5;

const fail = (e) => new ApiError('STORE_FAILED', 'No se pudo leer o guardar en Supabase.', { status: 500, detail: e?.message || String(e) });
const run = async (q) => {
  const { data, error } = await q;
  if (error) throw Object.assign(fail(error), { pgCode: error.code });
  return data;
};

export const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
export const codeHash = (code) => createHmac('sha256', process.env.TOKEN_SECRET || '').update(`vinculacion:${code}`).digest('hex');

// Creates a fresh code for the user, revoking previous unused ones. Rate limited per user.
export async function createCode(userId) {
  const db = supabase();
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const recent = await run(db.from('codigos_vinculacion').select('id').eq('user_id', userId).gt('created_at', hourAgo));
  if (recent.length >= MAX_CODES_PER_HOUR) {
    throw new ApiError('CODE_RATE_LIMIT', 'Generaste demasiados códigos en la última hora; espera un momento.', { status: 429 });
  }
  const nowIso = new Date().toISOString();
  await run(db.from('codigos_vinculacion').update({ expires_at: nowIso }).eq('user_id', userId).is('used_at', null).gt('expires_at', nowIso));
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
  for (let i = 0; i < 5; i++) {
    const code = newCode();
    try {
      await run(db.from('codigos_vinculacion').insert({ user_id: userId, code_hash: codeHash(code), expires_at: expiresAt }));
      return { code, expiresAt };
    } catch (e) {
      if (e.pgCode !== '23505') throw e; // hash collision: try another code
    }
  }
  throw new ApiError('CODE_GENERATION_FAILED', 'No se pudo generar un código; intenta de nuevo.', { status: 500 });
}

export async function getLink(userId) {
  return run(supabase().from('vinculos_whatsapp').select('phone, linked_at').eq('user_id', userId).maybeSingle());
}
