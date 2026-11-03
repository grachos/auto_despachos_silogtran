// Browser session cookie for the web pages: a signed, short-lived token (typ "session") in an HttpOnly cookie.
import { signToken, verifyToken } from '../token.js';

const NAME = 'sid';
const TTL_SEC = 30 * 60;

export function setSessionCookie(res, userId) {
  const token = signToken({ uid: userId }, TTL_SEC, 'session');
  res.setHeader('set-cookie', `${NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${TTL_SEC}`);
}

// Returns the user id from the cookie, or null if missing/invalid/expired.
export function readSession(req) {
  const m = new RegExp(`(?:^|;\\s*)${NAME}=([^;]+)`).exec(req.headers.cookie || '');
  if (!m) return null;
  try {
    return verifyToken(m[1], 'session').uid ?? null;
  } catch {
    return null;
  }
}
