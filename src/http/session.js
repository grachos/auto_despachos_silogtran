// Browser session cookies for the web pages: a signed, short-lived token (typ "session") in an HttpOnly cookie, ONE PER PURPOSE.
// An invitation link is for a single purpose ('whatsapp' | 'activar' | …) and its session only opens that purpose's pages: a person
// logged in through the WhatsApp link cannot reach the activation page (and vice versa) without their own link.
// The WhatsApp cookie keeps the historical name `sid` (and cookies without a scope count as WhatsApp).
import { signToken, verifyToken } from '../token.js';
import { ApiError } from './errors.js';
import { getUser } from '../store/usuarios.js';

const TTL_SEC = 30 * 60;
export const cookieName = (scope) => (scope === 'whatsapp' ? 'sid' : `sid_${scope}`);

export function setSessionCookie(res, userId, scope = 'whatsapp') {
  const token = signToken({ uid: userId, sc: scope }, TTL_SEC, 'session');
  res.setHeader('set-cookie', `${cookieName(scope)}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${TTL_SEC}`);
}

// Returns the user id from the cookie of that purpose, or null if missing/invalid/expired/for another purpose.
export function readSession(req, scope = 'whatsapp') {
  const m = new RegExp(`(?:^|;\\s*)${cookieName(scope)}=([^;]+)`).exec(req.headers.cookie || '');
  if (!m) return null;
  try {
    const p = verifyToken(m[1], 'session');
    return (p.sc ?? 'whatsapp') === scope ? (p.uid ?? null) : null;
  } catch {
    return null;
  }
}

// Requires a valid session cookie of that purpose for an ACTIVE user; returns the user row.
export async function requireSession(req, scope = 'whatsapp') {
  const uid = readSession(req, scope);
  const user = uid ? await getUser(uid) : null;
  if (!user || user.status !== 'ACTIVE') {
    throw new ApiError('SESSION_REQUIRED', 'Tu sesión venció o no existe; entra de nuevo con el link de invitación que te dio el administrador para esto.', { status: 401 });
  }
  return user;
}
