// GET /api/invitaciones/:token/login — what the link is for (no attempt spent).
// POST /api/invitaciones/:token/login { usuario, clave } — verifies the person's Silogtran credentials with a real
// login. On success the link is consumed, the credentials are stored encrypted and a session cookie is set.
// The password is never logged or returned.
import { ApiError, sendError } from '../../../src/http/errors.js';
import { requireEnv } from '../../../src/config.js';
import { loginWithInvitation, peekInvitation } from '../../../src/invitaciones.js';
import { SCOPE_PAGE } from '../../../src/store/usuarios.js';
import { setSessionCookie } from '../../../src/http/session.js';
import { requireEncryptionKey } from '../../../src/crypto.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST' && req.method !== 'GET') {
      res.setHeader('allow', 'GET, POST');
      return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
    }
    requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'TOKEN_SECRET');
    const token = String(req.query.token || '');
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new ApiError('INVITATION_NOT_FOUND', 'El link de invitación no existe.', { status: 404 });
    res.setHeader('cache-control', 'no-store');
    if (req.method === 'GET') {
      const { scope } = await peekInvitation(token);
      return res.status(200).json({ ok: true, scope });
    }
    requireEncryptionKey();
    const { user, costCenter, scope } = await loginWithInvitation(token, req.body);
    setSessionCookie(res, user.id, scope);
    res.status(200).json({ ok: true, usuario: user, centroCosto: costCenter, scope, siguiente: SCOPE_PAGE[scope] ?? '/vincular' });
  } catch (e) {
    res.setHeader('cache-control', 'no-store');
    sendError(res, e);
  }
}
