// POST /api/admin/diag-solicitudes { usuario?, fecha? } — READ-ONLY. Shows what the dispatch viewer and the request search screen offer
// (filters, columns, a short sample, pagination hints) to design "list the requests I can dispatch". Saves/confirms nothing.
import { sendError, ApiError } from '../../http/errors.js';
import { requireConfig } from '../../config.js';
import { requireAdmin } from '../../http/admin.js';
import { withLock } from '../../store/locks.js';
import { assertActorActive, openActorSession, resolveActorId, sessionKey } from '../../silogtran/userSession.js';
import { inspectSolicitudScreens } from '../../silogtran/diagSolicitudes.js';

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  try {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
    }
    requireAdmin(req);
    requireConfig();
    const fecha = req.body?.fecha == null ? undefined : String(req.body.fecha);
    if (fecha !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new ApiError('INVALID_PARAMETER', 'fecha debe ser yyyy-mm-dd.', { status: 400 });
    const userId = await resolveActorId(req.body?.usuario);
    await assertActorActive(userId);
    const out = await withLock(sessionKey(userId), async () => {
      const { client } = await openActorSession(userId);
      return client.enqueue(() => inspectSolicitudScreens(client, { fecha }));
    });
    res.status(200).json(out);
  } catch (e) {
    sendError(res, e);
  }
}
