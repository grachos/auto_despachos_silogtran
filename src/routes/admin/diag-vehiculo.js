// POST /api/admin/diag-vehiculo { numero, placa, usuario, item?, completo? } — READ-ONLY comparison of the vehicle loaded through
// "Vehículos Activos" vs the "Empresas" tab (control ids and filled/sent flags only, never values). Saves nothing.
import { sendError, ApiError } from '../../http/errors.js';
import { requireConfig } from '../../config.js';
import { requireAdmin } from '../../http/admin.js';
import { withLock } from '../../store/locks.js';
import { assertActorActive, openActorSession, resolveActorId, sessionKey } from '../../silogtran/userSession.js';
import { assertNumero } from '../../dispatch/service.js';
import { diagnoseVehicle } from '../../silogtran/diagnostico.js';

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  try {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
    }
    requireAdmin(req);
    requireConfig();
    const numero = assertNumero(req.body?.numero);
    const placa = String(req.body?.placa ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,10}$/.test(placa)) throw new ApiError('INVALID_PARAMETER', 'Placa inválida.', { status: 400 });
    const item = req.body?.item == null ? null : Number(req.body.item);
    const userId = await resolveActorId(req.body?.usuario);
    await assertActorActive(userId);
    const out = await withLock(sessionKey(userId), async () => {
      const { client } = await openActorSession(userId);
      return diagnoseVehicle(client, numero, { placa, item, completo: req.body?.completo === true, codigo: req.body?.codigo === true });
    });
    res.status(200).json(out);
  } catch (e) {
    sendError(res, e);
  }
}
