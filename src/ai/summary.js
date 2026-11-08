// Confirmation text and buttons built by CODE from the structured summary Silogtran returned
// (never paraphrased by the model): what the person confirms is what Silogtran actually matched.
const when = (fecha, hora) => {
  const d = new Date(`${fecha}T${String(hora).length === 5 ? hora + ':00' : hora}-05:00`);
  return Number.isNaN(d.getTime()) ? `${fecha} ${hora}` : d.toLocaleString('es-CO', { timeZone: 'America/Bogota', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
};
const money = (n) => `$${Number(n).toLocaleString('es-CO')}`;
const clean = (v) => String(v ?? '—').replace(/[\u0000-\u001f]/g, ' ').slice(0, 80);

const span = (t) => `${Number(t?.horas) || 0} h${Number(t?.minutos) ? ` ${Number(t.minutos)} min` : ''}`;

export function buildSummaryText(r) {
  const lines = [
    '📋 *Resumen del despacho*',
    `Solicitud: ${clean(r.solicitud.numero)} (ítem ${clean(r.solicitud.item)}) · ${clean(r.solicitud.origen)} → ${clean(r.solicitud.destino)}`,
    `Vehículo: ${clean(r.vehiculo.placa)} · ${clean(r.vehiculo.clase)} · ${clean(r.vehiculo.carroceria)}`,
    ...(r.tipoAfiliado ? [`Afiliado: ${clean(r.tipoAfiliado)}`] : []),
    `Cargado por: ${fuenteLabel(r.fuente)}`,
    `Remolque: ${clean(r.trailer)}`,
    `Conductor: ${clean(r.conductor)}`,
    `Ruta: ${clean(r.ruta)}`,
    `Manifiesto: ${clean(r.tipoManifiesto?.nombre)}`,
    ...(r.tipoOperacion?.nombre ? [`Tipo de operación: ${clean(r.tipoOperacion.nombre)}`] : []),
    `Cita de cargue: ${when(r.fechas.citaCargue.fecha, r.fechas.citaCargue.hora)}`,
    `Cita de descargue: ${when(r.fechas.citaDescargue.fecha, r.fechas.citaDescargue.hora)}`,
    ...(r.tiempos ? [`Tiempos pactados: cargue ${span(r.tiempos.cargue)} · descargue ${span(r.tiempos.descargue)}`] : []),
  ];
  if (r.contenedor) lines.push(`Contenedor: ${clean(r.contenedor.numero)} · BL: ${clean(r.contenedor.bl)}`);
  if (r.eleccion) {
    // With a zero anticipo nothing is paid: the beneficiary line would only confuse.
    if (r.eleccion.anticipo > 0) lines.push(`Beneficiario del anticipo: ${clean(r.eleccion.beneficiario.texto)}`);
    lines.push(`Anticipo a entregar: ${money(r.eleccion.anticipo)}`);
    if (r.eleccion.anticipo > 0) lines.push('Banco: BANCOLOMBIA TERCEROS');
  } else lines.push(`Anticipo sugerido: ${money(r.anticipoSugerido)}`);
  lines.push('', 'Revisa que todo esté bien y elige una opción. No se graba nada hasta que pulses un botón de confirmar.');
  return lines.join('\n');
}

// Button ids carry the pending id: ctot/ccero = confirm with that anticipo, canc = cancel.
// External vehicles: beneficiary and value were already chosen (resumen.eleccion), so only Confirm (cok) / Cancel.
export function buildButtons(pendingId, r) {
  if (r && typeof r === 'object' && r.tipoAfiliado === 'EXTERNO') {
    return r.eleccion ? [{ id: `cok:${pendingId}`, title: 'Confirmar' }, { id: `canc:${pendingId}`, title: 'Cancelar' }] : [{ id: `canc:${pendingId}`, title: 'Cancelar' }];
  }
  const anticipoSugerido = r && typeof r === 'object' ? r.anticipoSugerido : r;
  return anticipoSugerido > 0
    ? [{ id: `ctot:${pendingId}`, title: 'Anticipo total' }, { id: `ccero:${pendingId}`, title: 'Anticipo cero' }, { id: `canc:${pendingId}`, title: 'Cancelar' }]
    : [{ id: `ccero:${pendingId}`, title: 'Confirmar' }, { id: `canc:${pendingId}`, title: 'Cancelar' }];
}

// ctot/ccero = confirm, canc = cancel, rep = prepare again with the same data (expired summary).
export const BUTTON_ID = /^(ctot|ccero|cok|canc|rep):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export const fuenteLabel = (f) => (f === 'empresas' ? 'pestaña Empresas' : 'Vehículos Activos');

export function resultText(r, resumen) {
  const d = r.documents ?? {};
  const lines = [r.repeated ? 'ℹ️ Este despacho ya estaba confirmado.' : '✅ ¡Despacho confirmado!', `Orden de cargue: ${d.ordenCargue ?? '—'}`, `Remesa: ${d.remesa ?? '—'}`, `Manifiesto: ${d.manifiesto ?? '—'}`];
  if (d.transferencia) lines.push(`Transferencia: ${d.transferencia}`);
  if (resumen) lines.push(`Cargado por: ${fuenteLabel(resumen.fuente)}`);
  if (r.ministerio !== 'NO_APLICA') lines.push(r.rndc?.migrated ? `Ministerio: radicado ${r.rndc.radicado}` : 'Ministerio: verificando el radicado… te aviso por aquí en un momento.');
  return lines.join('\n');
}
