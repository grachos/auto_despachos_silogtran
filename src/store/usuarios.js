// Persistence for app users and invitations (Supabase, service key). Raw invitation tokens are never stored.
import { supabase } from './supabase.js';
import { ApiError } from '../http/errors.js';
import { encrypt, decrypt } from '../crypto.js';

const fail = (e) => new ApiError('STORE_FAILED', 'No se pudo leer o guardar en Supabase.', { status: 500, detail: e?.message || String(e) });
const run = async (q) => {
  const { data, error } = await q;
  if (error) throw fail(error);
  return data;
};

// A user flagged relink_required is reported as NEEDS_RELINK (stored as status DISABLED so every
// "is ACTIVE?" check fails safe; the flag only selects the message).
const eff = (u) => (u ? { ...u, status: u.relink_required ? 'NEEDS_RELINK' : u.status } : u);

export const MAX_ATTEMPTS = 5;
export const INVITATION_TTL_MS = 2 * 60 * 60 * 1000;

export const createUser = async (nombre) => (await run(supabase().from('app_users').insert({ nombre }).select('id, nombre').single()));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Finds an existing user by internal id (uuid) or by Silogtran username (case-insensitive). Admin use.
export async function findUserByRef(ref) {
  const r = String(ref ?? '').trim();
  if (!r) return null;
  const q = supabase().from('app_users').select('id, nombre, silog_user, status, relink_required');
  return eff(await run(UUID_RE.test(r) ? q.eq('id', r).maybeSingle() : q.eq('silog_user_key', r.toLowerCase()).maybeSingle()));
}

export const getUser = async (id) => eff(await run(supabase().from('app_users').select('id, nombre, silog_user, status, relink_required').eq('id', id).maybeSingle()));

// One link per purpose. 'despachar' is reserved for the dispatch MCP (M6) and cannot be issued yet.
export const INVITE_SCOPES = ['whatsapp', 'activar', 'despachar'];
export const SCOPE_PAGE = { whatsapp: '/vincular', activar: '/mcp', despachar: '/mcp-despacho' };

export async function createInvitation(userId, tokenHash, scope = 'whatsapp') {
  const nowIso = new Date().toISOString();
  // Re-inviting revokes earlier unused links of the same user AND the same purpose (the other purposes' links stay valid).
  await run(supabase().from('invitaciones').update({ expires_at: nowIso }).eq('user_id', userId).eq('scope', scope).is('used_at', null).gt('expires_at', nowIso));
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS).toISOString();
  await run(supabase().from('invitaciones').insert({ user_id: userId, token_hash: tokenHash, expires_at: expiresAt, scope }));
  return expiresAt;
}

export const findInvitationByHash = async (hash) =>
  (await run(supabase().from('invitaciones').select('id, user_id, expires_at, used_at, attempts, scope').eq('token_hash', hash).maybeSingle()));

// Atomic compare-and-set: succeeds only if attempts is still `n`, the link is unused, unexpired and below the limit.
export async function reserveAttempt(hash, n) {
  const rows = await run(
    supabase().from('invitaciones').update({ attempts: n + 1 }).eq('token_hash', hash).eq('attempts', n).lt('attempts', MAX_ATTEMPTS)
      .is('used_at', null).gt('expires_at', new Date().toISOString()).select('attempts'),
  );
  return rows.length === 1;
}

export async function refundAttempt(hash) {
  for (let i = 0; i < 3; i++) {
    const inv = await findInvitationByHash(hash);
    if (!inv || inv.used_at || inv.attempts <= 0) return;
    const rows = await run(supabase().from('invitaciones').update({ attempts: inv.attempts - 1 }).eq('token_hash', hash).eq('attempts', inv.attempts).select('attempts'));
    if (rows.length === 1) return;
  }
}

// Marks the invitation used; only one concurrent caller can win.
export async function consumeInvitation(hash) {
  const rows = await run(
    supabase().from('invitaciones').update({ used_at: new Date().toISOString() }).eq('token_hash', hash).is('used_at', null)
      .gt('expires_at', new Date().toISOString()).select('id'),
  );
  return rows.length === 1;
}

export async function silogUserTaken(silogUser, exceptUserId) {
  const rows = await run(supabase().from('app_users').select('id').eq('silog_user_key', silogUser.toLowerCase()).neq('id', exceptUserId).limit(1));
  return rows.length > 0;
}

export async function activateUser(userId, silogUser, password) {
  await run(
    supabase().from('app_users').update({
      silog_user: silogUser,
      silog_user_key: silogUser.toLowerCase(),
      silog_password_enc: encrypt(password, userId),
      status: 'ACTIVE',
      relink_required: false,
      updated_at: new Date().toISOString(),
    }).eq('id', userId),
  );
}

// Decrypted only in memory, only to open a Silogtran session (used from M4 on). Never log or return it.
export async function getCredentials(userId) {
  const u = await run(supabase().from('app_users').select('silog_user, silog_password_enc, status, relink_required').eq('id', userId).maybeSingle());
  if (u?.relink_required) {
    throw new ApiError('RELINK_REQUIRED', 'Tu contraseña de Silogtran ya no es válida; pide un link nuevo para actualizarla.', { status: 403 });
  }
  if (!u || u.status !== 'ACTIVE' || !u.silog_password_enc) {
    throw new ApiError('USER_NOT_ACTIVE', 'El usuario no está activo o no ha configurado sus credenciales de Silogtran.', { status: 403 });
  }
  return { user: u.silog_user, password: decrypt(u.silog_password_enc, userId) };
}

// Atomic: only the caller that actually flips ACTIVE -> relink gets `true` (and should notify the person).
export async function flipNeedsRelink(userId) {
  const rows = await run(
    supabase().from('app_users').update({ status: 'DISABLED', relink_required: true, updated_at: new Date().toISOString() })
      .eq('id', userId).eq('status', 'ACTIVE').select('id'),
  );
  return rows.length === 1;
}
