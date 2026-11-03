// POST /api/invitaciones/:token/login { usuario, clave } — verifies the person's Silogtran credentials with a real
// login. On success the link is consumed, the credentials are stored encrypted and a session cookie is set.
// The password is never logged or returned.
import { ApiError, sendError } from '../../../src/http/errors.js';
import { requireEnv } from '../../../src/config.js';
import { loginWithInvitation } from '../../../src/invitaciones.js';
import { setSessionCookie } from '../../../src/http/session.js';
import { requireEncryptionKey } from '../../../src/crypto.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
    }
    requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'TOKEN_SECRET');
    requireEncryptionKey();
    const token = String(req.query.token || '');
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new ApiError('INVITATION_NOT_FOUND', 'El link de invitación no existe.', { status: 404 });
    const { user, costCenter } = await loginWithInvitation(token, req.body);
    setSessionCookie(res, user.id);
    res.setHeader('cache-control', 'no-store');
    res.status(200).json({ ok: true, usuario: user, centroCosto: costCenter });
  } catch (e) {
    res.setHeader('cache-control', 'no-store');
    sendError(res, e);
  }
}
