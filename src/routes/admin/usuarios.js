// GET /api/admin/usuarios — users, WhatsApp link status and dispatch counts.
import { sendError } from '../../http/errors.js';
import { requireEnv } from '../../config.js';
import { requireAdmin } from '../../http/admin.js';
import { listUsers } from '../../store/admin.js';

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  try {
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET');
      return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' });
    }
    requireAdmin(req);
    requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_KEY');
    const usuarios = await listUsers();
    res.status(200).json({
      ok: true,
      resumen: {
        total: usuarios.length,
        activos: usuarios.filter((u) => u.estado === 'ACTIVE').length,
        vinculados: usuarios.filter((u) => u.whatsapp === 'VINCULADO').length,
        requierenLink: usuarios.filter((u) => u.estado === 'NEEDS_RELINK').length,
      },
      usuarios,
    });
  } catch (e) {
    sendError(res, e);
  }
}
