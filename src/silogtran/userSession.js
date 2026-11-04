// Silogtran session of the person who owns a dispatch ("actor"). userId === null means user zero (env credentials).
// Credentials are decrypted only here, in memory, to (re)login. A hard credential failure flips the user to
// "needs relink" ONCE (atomically), notifies them, and every later call stops at the status check without
// touching Silogtran (protects their Silogtran account from lockout).
import { ApiError } from '../http/errors.js';
import { openSession } from './session.js';
import { findUserByRef, getUser, getCredentials, flipNeedsRelink } from '../store/usuarios.js';
import { getPhoneByUser } from '../store/whatsapp.js';
import { sendText } from '../whatsapp/api.js';

export const RELINK_TEXT =
  '⚠️ Tu usuario o contraseña de Silogtran ya no son válidos (¿los cambiaste?). Para seguir despachando, pide un link nuevo al administrador y vuelve a ingresar. Mientras tanto no puedo despachar por ti.';

export const sessionKey = (userId) => userId ?? 'default';

// Best effort: Meta only allows free-form text inside the 24 h window, so this can legitimately fail.
export async function notifyRelink(userId) {
  try {
    const phone = await getPhoneByUser(userId);
    if (phone) await sendText(phone, RELINK_TEXT);
  } catch (e) {
    console.error('[relink-notify] not sent:', e?.code || 'error');
  }
}

const real = { getUser, getCredentials, openSession, flipNeedsRelink, notify: notifyRelink };

// Silogtran said the credentials are wrong (panel message, forced password change, 2FA).
// The generic "rejected the login" and every infrastructure error are NOT hard failures.
export const isHardCredentialFailure = (e) =>
  e?.name === 'SilogtranError' && e.code === 'LOGIN_FAILED' && /^Login failed:|password change|2FA/i.test(String(e.message));

export async function resolveActorId(ref) {
  const r = String(ref ?? '').trim();
  if (!r) return null;
  const u = await findUserByRef(r);
  if (!u) throw new ApiError('USER_NOT_FOUND', 'No existe ese usuario. Indica su ID o su usuario de Silogtran.', { status: 404 });
  return u.id;
}

// DB-only check (never touches Silogtran).
export async function assertActorActive(userId, deps = real) {
  if (!userId) return;
  const u = await deps.getUser(userId);
  if (!u) throw new ApiError('USER_NOT_FOUND', 'No existe ese usuario.', { status: 404 });
  if (u.status === 'NEEDS_RELINK') {
    throw new ApiError('RELINK_REQUIRED', 'Tu contraseña de Silogtran ya no es válida; pide un link nuevo para actualizarla.', { status: 403 });
  }
  if (u.status !== 'ACTIVE') throw new ApiError('USER_NOT_ACTIVE', 'El usuario no está activo.', { status: 403 });
}

export async function openActorSession(userId, deps = real) {
  if (!userId) return deps.openSession();
  const { user, password } = await deps.getCredentials(userId);
  try {
    return await deps.openSession({ userId, user, password });
  } catch (e) {
    if (isHardCredentialFailure(e)) {
      if (await deps.flipNeedsRelink(userId)) await deps.notify(userId); // only the caller that flipped notifies
      throw new ApiError('CREDENTIALS_INVALID', 'Tu usuario o contraseña de Silogtran ya no son válidos. Pide un link nuevo para actualizarlos.', { status: 401 });
    }
    throw e;
  }
}
