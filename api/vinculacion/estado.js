// GET /api/vinculacion/estado — (session cookie) whether the user's WhatsApp is already linked.
import { sendError } from '../../src/http/errors.js';
import { requireEnv } from '../../src/config.js';
import { requireSession } from '../../src/http/session.js';
import { getLink } from '../../src/store/vinculacion.js';
import { botDisplay } from '../../src/whatsapp.js';

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  try {
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET');
      return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' });
    }
    requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'TOKEN_SECRET');
    const user = await requireSession(req);
    const link = await getLink(user.id);
    res.status(200).json({
      ok: true,
      usuario: { nombre: user.nombre, silogUser: user.silog_user },
      vinculado: Boolean(link),
      desde: link?.linked_at ?? null,
      telefono: link ? `••••${String(link.phone).slice(-4)}` : null,
      numeroWhatsapp: botDisplay(),
    });
  } catch (e) {
    sendError(res, e);
  }
}
