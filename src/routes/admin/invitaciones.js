// POST /api/admin/invitaciones { nombre | userId, scope? ('whatsapp' default | 'activar') } — creates an app user (or re-invites one) and returns a
// single-use link that expires in 2 hours. Admin only (ADMIN_KEY header or admin cookie). The raw token is shown once.
import { requireAdmin } from '../../http/admin.js';
import { ApiError, sendError } from '../../http/errors.js';
import { requireEnv } from '../../config.js';
import { createUser, findUserByRef, createInvitation, INVITE_SCOPES } from '../../store/usuarios.js';
import { hashToken, newRawToken } from '../../invitaciones.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
    }
    requireAdmin(req);
    requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_KEY');
    const { nombre, userId, scope: rawScope } = req.body && typeof req.body === 'object' ? req.body : {};

    const scope = String(rawScope ?? 'whatsapp');
    if (!INVITE_SCOPES.includes(scope)) throw new ApiError('INVALID_PARAMETER', `Tipo de link inválido; usa: ${INVITE_SCOPES.join(', ')}.`, { status: 400 });
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
    const expiresAt = await createInvitation(user.id, hashToken(raw), scope);
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    res.status(200).json({
      ok: true,
      usuario: { id: user.id, nombre: user.nombre },
      invitacion: { tipo: scope, link: `https://${host}/invitacion?t=${raw}`, token: raw, expiraEn: expiresAt, horasDeVigencia: 2 },
    });
  } catch (e) {
    sendError(res, e);
  }
}
