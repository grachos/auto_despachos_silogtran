// POST /api/solicitudes/:numero/iniciar — DIAGNOSTIC (increment 3a, to be absorbed into `preparar`).
// Runs the viewer flow up to ticking genera_manifiesto, reports the state, then clears the pending
// item. Nothing is saved in Silogtran. Body (optional): { item, placa, tipoManifiesto }; with `placa` it also
// fills vehicle, route, dates and manifest type (increment 3b).
import { requireApiKey } from '../../../src/http/auth.js';
import { ApiError, sendError } from '../../../src/http/errors.js';
import { requireConfig } from '../../../src/config.js';
import { openSession } from '../../../src/silogtran/session.js';
import { buscarSolicitud } from '../../../src/silogtran/solicitud.js';
import { clearPending, pickItem, startDispatch } from '../../../src/silogtran/despacho.js';
import { PradoPage } from '../../../src/silogtran/prado.js';
import { fillInformacion } from '../../../src/silogtran/informacion.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
    }
    requireApiKey(req);
    requireConfig();
    const numero = String(req.query.numero || '').trim();
    if (!/^\d{4,20}$/.test(numero)) {
      throw new ApiError('INVALID_PARAMETER', 'El número de solicitud debe contener solo dígitos (4 a 20).', { status: 400 });
    }
    const wanted = req.body?.item == null ? null : Number(req.body.item);
    if (wanted != null && !Number.isInteger(wanted)) {
      throw new ApiError('INVALID_PARAMETER', 'El campo item debe ser un número entero.', { status: 400 });
    }

    const { client } = await openSession();
    const solicitud = await buscarSolicitud(client, numero);
    const chosen = pickItem(solicitud, wanted);

    let result;
    try {
      result = await client.enqueue(async () => {
        const d = await startDispatch(client, { numero, item: chosen.item, fechaCreacion: solicitud.fechaCreacion });
        if (!req.body?.placa) return { state: d.state };
        const info = await fillInformacion(new PradoPage(client, d.page), {
          placa: req.body.placa,
          origen: chosen.origen,
          destino: chosen.destino,
          tipoManifiesto: req.body.tipoManifiesto,
        });
        return { state: d.state, info };
      });
    } finally {
      // Never leave the item pending in the Silogtran session.
      await client.enqueue(() => clearPending(client)).catch((e) => console.error('[cleanup]', e?.message));
    }
    res.status(200).json({
      ok: true,
      step: 'MANIFIESTO_MARCADO',
      solicitud: { numero, item: chosen.item, origen: chosen.origen, destino: chosen.destino, requiereContenedor: solicitud.requiereContenedor },
      state: result.state,
      info: result.info,
      pendingCleared: true,
    });
  } catch (e) {
    sendError(res, e);
  }
}
