// POST /api/admin/diag-placa { placa, usuario?, estado? } — READ-ONLY. Searches the plate in Silogtran's vehicle master and, if found, reads the
// record's catalog fields (status, affiliate type...). Used to learn the real structure before checking plates ahead of a dispatch.
import { sendError, ApiError } from '../../http/errors.js';
import { requireConfig } from '../../config.js';
import { requireAdmin } from '../../http/admin.js';
import { withLock } from '../../store/locks.js';
import { assertActorActive, openActorSession, resolveActorId, sessionKey } from '../../silogtran/userSession.js';
import { inspectPlate } from '../../silogtran/diagPlaca.js';

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  try {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
    }
    requireAdmin(req);
    requireConfig();
    const placa = String(req.body?.placa ?? '').trim().toUpperCase();
    const estado = req.body?.estado == null ? null : String(req.body.estado).trim();
    if (estado != null && !/^\d{1,3}$/.test(estado)) throw new ApiError('INVALID_PARAMETER', 'Estado inválido (valor numérico del filtro «estado» de la búsqueda).', { status: 400 });
    if (!(placa === '' && estado != null) && !/^[A-Z0-9]{4,10}$/.test(placa)) throw new ApiError('INVALID_PARAMETER', 'Placa inválida.', { status: 400 });
    const userId = await resolveActorId(req.body?.usuario);
    await assertActorActive(userId);
    const out = await withLock(sessionKey(userId), async () => {
      const { client } = await openActorSession(userId);
      return client.enqueue(() => inspectPlate(client, placa, estado));
    });
    res.status(200).json(out);
  } catch (e) {
    sendError(res, e);
  }
}
