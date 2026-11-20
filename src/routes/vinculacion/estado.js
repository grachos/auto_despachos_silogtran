// GET /api/vinculacion/estado — (session cookie) whether the user's WhatsApp is already linked.
import { sendError } from '../../http/errors.js';
import { requireEnv } from '../../config.js';
import { requireSession } from '../../http/session.js';
import { getLinks } from '../../store/vinculacion.js';
import { MAX_PHONES_PER_USER } from '../../store/whatsapp.js';
import { botDisplay } from '../../whatsapp.js';

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  try {
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET');
      return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' });
    }
    requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'TOKEN_SECRET');
    const user = await requireSession(req);
    const links = await getLinks(user.id);
    const mask = (p) => `••••${String(p).slice(-4)}`;
    res.status(200).json({
      ok: true,
      usuario: { nombre: user.nombre, silogUser: user.silog_user },
      vinculado: links.length > 0,
      // Up to MAX_PHONES_PER_USER numbers; desde/telefono keep the first one for older clients.
      telefonos: links.map((l) => ({ telefono: mask(l.phone), desde: l.linked_at })),
      maxTelefonos: MAX_PHONES_PER_USER,
      desde: links[0]?.linked_at ?? null,
      telefono: links[0] ? mask(links[0].phone) : null,
      numeroWhatsapp: botDisplay(),
    });
  } catch (e) {
    sendError(res, e);
  }
}
