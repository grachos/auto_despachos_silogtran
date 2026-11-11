// POST /api/admin/diag-activar { tipo:'vehiculo'|'tercero', valor:<placa|documento>, id?, usuario?, ejecutar?, confirmar? } — READ-ONLY unless `ejecutar:true` AND `confirmar` equals `valor` (then it REALLY activates that one vehicle / person). Terceros: `valor` = document; `id` = internal id when the document has several candidates. Walks the activation screen up to «Buscar Items» and reports
// the grid rows and controls. It never ticks a row nor presses «Aceptar» (nothing is activated). Terceros: pending (needs the browser captures).
import { sendError, ApiError } from '../../http/errors.js';
import { requireConfig } from '../../config.js';
import { requireAdmin } from '../../http/admin.js';
import { withLock } from '../../store/locks.js';
import { assertActorActive, openActorSession, resolveActorId, sessionKey } from '../../silogtran/userSession.js';
import { inspectVehicleActivation, activateVehicle } from '../../silogtran/activar.js';
import { inspectThirdPartyActivation, activateThirdParty } from '../../silogtran/terceros.js';

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
    if (!['vehiculo', 'tercero'].includes(tipo)) throw new ApiError('INVALID_PARAMETER', 'Tipo: "vehiculo" o "tercero".', { status: 400 });
    const valor = String(req.body?.valor ?? '').trim().toUpperCase();
    const userId = await resolveActorId(req.body?.usuario);
    await assertActorActive(userId);
    const out = await withLock(sessionKey(userId), async () => {
      const { client } = await openActorSession(userId);
      const write = req.body?.ejecutar === true;
      if (write && String(req.body?.confirmar ?? '').trim().toUpperCase() !== valor) throw new ApiError('CONFIRMATION_MISMATCH', 'Para activar de verdad, `confirmar` debe ser igual a `valor` (placa o documento).', { status: 400 });
      if (tipo === 'tercero') {
        const ref = { documento: valor, id: req.body?.id ?? null };
        if (write) return { ok: true, documento: valor, ...(await client.enqueue(() => activateThirdParty(client, ref))) };
        return client.enqueue(() => inspectThirdPartyActivation(client, ref));
      }
      if (write) return { ok: true, placa: valor, ...(await client.enqueue(() => activateVehicle(client, valor))) };
      return client.enqueue(() => inspectVehicleActivation(client, valor));
    });
    res.status(200).json(out);
  } catch (e) {
    sendError(res, e);
  }
}
