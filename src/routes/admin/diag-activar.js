// POST /api/admin/diag-activar { tipo:'vehiculo', valor:<placa>, usuario? } — READ-ONLY. Walks the activation screen up to «Buscar Items» and reports
// the grid rows and controls. It never ticks a row nor presses «Aceptar» (nothing is activated). Terceros: pending (needs the browser captures).
import { sendError, ApiError } from '../../http/errors.js';
import { requireConfig } from '../../config.js';
import { requireAdmin } from '../../http/admin.js';
import { withLock } from '../../store/locks.js';
import { assertActorActive, openActorSession, resolveActorId, sessionKey } from '../../silogtran/userSession.js';
import { inspectVehicleActivation } from '../../silogtran/activar.js';

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  try {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
    }
    requireAdmin(req);
    requireConfig();
    const tipo = String(req.body?.tipo ?? 'vehiculo');
    if (tipo !== 'vehiculo') throw new ApiError('INVALID_PARAMETER', 'Por ahora solo tipo "vehiculo".', { status: 400 });
    const valor = String(req.body?.valor ?? '').trim().toUpperCase();
    const userId = await resolveActorId(req.body?.usuario);
    await assertActorActive(userId);
    const out = await withLock(sessionKey(userId), async () => {
      const { client } = await openActorSession(userId);
      return client.enqueue(() => inspectVehicleActivation(client, valor));
    });
    res.status(200).json(out);
  } catch (e) {
    sendError(res, e);
  }
}
