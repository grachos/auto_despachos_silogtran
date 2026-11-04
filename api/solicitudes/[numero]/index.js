// GET /api/solicitudes/:numero[?usuario=<id|usuario Silogtran>] — read-only lookup (origin/destination per item,
// container flag), using the session of that user (default: user zero).
import { requireApiKey } from '../../../src/http/auth.js';
import { sendError } from '../../../src/http/errors.js';
import { requireConfig } from '../../../src/config.js';
import { resolveActorId } from '../../../src/silogtran/userSession.js';
import { consultSolicitud } from '../../../src/dispatch/service.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET');
      return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' });
    }
    requireApiKey(req);
    requireConfig();
    const userId = await resolveActorId(req.query?.usuario);
    res.status(200).json({ ok: true, solicitud: await consultSolicitud(userId, req.query.numero) });
  } catch (e) {
    sendError(res, e);
  }
}
