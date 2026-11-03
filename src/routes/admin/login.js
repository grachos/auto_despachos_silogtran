// POST /api/admin/login { key } — exchanges the ADMIN_KEY for an 8 h HttpOnly cookie (Path=/api/admin).
import { sendError, ApiError } from '../../http/errors.js';
import { requireEnv } from '../../config.js';
import { adminLogin, setAdminCookie } from '../../http/admin.js';

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  try {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
    }
    requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'TOKEN_SECRET', 'ADMIN_KEY');
    const key = req.body && typeof req.body === 'object' ? req.body.key : undefined;
    if (typeof key !== 'string' || !key) throw new ApiError('INVALID_PARAMETER', 'Falta la clave de administrador.', { status: 400 });
    await adminLogin(req, key);
    setAdminCookie(res);
    res.status(200).json({ ok: true });
  } catch (e) {
    sendError(res, e);
  }
}
