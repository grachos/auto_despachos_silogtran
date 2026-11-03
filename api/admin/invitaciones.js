// POST /api/admin/invitaciones { nombre } | { userId } — creates an app user (or re-invites one) and returns a
// single-use link that expires in 2 hours. Admin only (ADMIN_KEY header or admin cookie). The raw token is shown once.
import { requireAdmin } from '../../src/http/admin.js';
import { ApiError, sendError } from '../../src/http/errors.js';
import { requireEnv } from '../../src/config.js';
import { createUser, findUserByRef, createInvitation } from '../../src/store/usuarios.js';
import { hashToken, newRawToken } from '../../src/invitaciones.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
    }
    requireAdmin(req);
    requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_KEY');
    const { nombre, userId } = req.body && typeof req.body === 'object' ? req.body : {};

    let user;
    if (userId) {
      user = await findUserByRef(userId);
      if (!user) throw new ApiError('USER_NOT_FOUND', 'No existe ese usuario. Escribe su ID o su usuario de Silogtran.', { status: 404 });
    } else {
      const n = String(nombre ?? '').trim();
      if (!n || n.length > 80) throw new ApiError('INVALID_PARAMETER', 'Falta el nombre del usuario (máximo 80 caracteres).', { status: 400 });
      user = await createUser(n);
    }

    const raw = newRawToken();
    const expiresAt = await createInvitation(user.id, hashToken(raw));
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    res.status(200).json({
      ok: true,
      usuario: { id: user.id, nombre: user.nombre },
      invitacion: { link: `https://${host}/invitacion?t=${raw}`, token: raw, expiraEn: expiresAt, horasDeVigencia: 2 },
    });
  } catch (e) {
    sendError(res, e);
  }
}
