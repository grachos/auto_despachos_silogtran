// POST /api/vinculacion/codigo — (session cookie) creates a one-time code to link the user's WhatsApp.
// The person sends "VINCULAR <code>" to the bot number; the webhook (M3) consumes it.
import { sendError } from '../../http/errors.js';
import { requireEnv } from '../../config.js';
import { requireSession } from '../../http/session.js';
import { createCode } from '../../store/vinculacion.js';
import { botDisplay, waLink } from '../../whatsapp.js';

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  try {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
    }
    requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'TOKEN_SECRET');
    const user = await requireSession(req);
    const { code, expiresAt } = await createCode(user.id);
    const mensaje = `VINCULAR ${code}`;
    res.status(200).json({
      ok: true,
      codigo: code,
      mensaje,
      expiraEn: expiresAt,
      segundosDeVigencia: 600,
      numeroWhatsapp: botDisplay(),
      whatsappUrl: waLink(mensaje),
    });
  } catch (e) {
    sendError(res, e);
  }
}
