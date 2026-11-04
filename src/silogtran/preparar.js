// Full "preparar" pipeline: fills the whole dispatch form WITHOUT saving. With keepOpen the pending
// item and the filled form are kept for `confirmar`; otherwise the pending item is always cleared.
import { ApiError } from '../http/errors.js';
import { buscarSolicitud } from './solicitud.js';
import { clearPending, pickItem, startDispatch } from './despacho.js';
import { PradoPage } from './prado.js';
import { fillInformacion, need, parseMoney } from './informacion.js';
import { addObservaciones, addContenedor } from './pestanas.js';

export async function runPreparation(client, numero, input, { keepOpen = false } = {}) {
  const solicitud = await buscarSolicitud(client, numero);
  const chosen = pickItem(solicitud, input.item);
  if (solicitud.requiereContenedor && (!input.contenedor || !input.bl)) {
    throw new ApiError('CONTAINER_REQUIRED', 'La solicitud requiere contenedor: envía contenedor y bl (número de BL).', { status: 400 });
  }

  let kept = false;
  try {
    const out = await client.enqueue(async () => {
      const d = await startDispatch(client, { numero, item: chosen.item, fechaCreacion: solicitud.fechaCreacion });
      const form = new PradoPage(client, d.page);
      const info = await fillInformacion(form, {
        placa: input.placa,
        origen: chosen.origen,
        destino: chosen.destino,
        tipoManifiesto: input.tipoManifiesto,
      });
      await addObservaciones(form, { numero, item: chosen.item, input });
      const contenedor = solicitud.requiereContenedor ? await addContenedor(form, { input }) : null;

      // Re-read the anticipo at the end: later postbacks may recalculate it.
      const anticipo = parseMoney(form.fields[need(form, 'ctl0$MainModule$Anticipo')]);
      if (anticipo === null) throw new ApiError('ANTICIPO_NOT_CALCULATED', 'Silogtran no calculó el anticipo.', { status: 502 });

      const summary = {
        solicitud: { numero, item: chosen.item, origen: chosen.origen, destino: chosen.destino },
        vehiculo: { placa: info.vehiculo.placa, clase: info.vehiculo.clase, carroceria: info.vehiculo.carroceria },
        tipoAfiliado: info.vehiculo.tipoAfiliado,
        beneficiarios: info.vehiculo.beneficiarios,
        tipoOperacion: info.vehiculo.tipoOperacion,
        trailer: info.vehiculo.trailer,
        conductor: info.vehiculo.conductor,
        ruta: info.ruta.ruta,
        tipoManifiesto: info.tipoManifiesto,
        fechas: { ...info.fechas, citaCargue: input.citaCargue, citaDescargue: input.citaDescargue },
        anticipoSugerido: anticipo,
        requiereContenedor: solicitud.requiereContenedor,
        contenedor,
      };
      return { form, summary, item: chosen.item };
    });
    kept = keepOpen;
    return out;
  } finally {
    if (!kept) await client.enqueue(() => clearPending(client)).catch((e) => console.error('[cleanup]', e?.message));
  }
}
