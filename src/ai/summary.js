// Confirmation text and buttons built by CODE from the structured summary Silogtran returned
// (never paraphrased by the model): what the person confirms is what Silogtran actually matched.
const when = (fecha, hora) => {
  const d = new Date(`${fecha}T${String(hora).length === 5 ? hora + ':00' : hora}-05:00`);
  return Number.isNaN(d.getTime()) ? `${fecha} ${hora}` : d.toLocaleString('es-CO', { timeZone: 'America/Bogota', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
};
const money = (n) => `$${Number(n).toLocaleString('es-CO')}`;
const clean = (v) => String(v ?? '—').replace(/[\u0000-\u001f]/g, ' ').slice(0, 80);

export function buildSummaryText(r) {
  const lines = [
    '📋 *Resumen del despacho*',
    `Solicitud: ${clean(r.solicitud.numero)} (ítem ${clean(r.solicitud.item)}) · ${clean(r.solicitud.origen)} → ${clean(r.solicitud.destino)}`,
    `Vehículo: ${clean(r.vehiculo.placa)} · ${clean(r.vehiculo.clase)} · ${clean(r.vehiculo.carroceria)}`,
    `Remolque: ${clean(r.trailer)}`,
    `Conductor: ${clean(r.conductor)}`,
    `Ruta: ${clean(r.ruta)}`,
    `Manifiesto: ${clean(r.tipoManifiesto?.nombre)}`,
    `Cita de cargue: ${when(r.fechas.citaCargue.fecha, r.fechas.citaCargue.hora)}`,
    `Cita de descargue: ${when(r.fechas.citaDescargue.fecha, r.fechas.citaDescargue.hora)}`,
  ];
  if (r.contenedor) lines.push(`Contenedor: ${clean(r.contenedor.numero)} · BL: ${clean(r.contenedor.bl)}`);
  lines.push(`Anticipo sugerido: ${money(r.anticipoSugerido)}`, '', 'Revisa que todo esté bien y elige una opción. No se graba nada hasta que pulses un botón de confirmar.');
  return lines.join('\n');
}

// Button ids carry the pending id: ctot/ccero = confirm with that anticipo, canc = cancel.
export function buildButtons(pendingId, anticipoSugerido) {
  return anticipoSugerido > 0
    ? [{ id: `ctot:${pendingId}`, title: 'Anticipo total' }, { id: `ccero:${pendingId}`, title: 'Anticipo cero' }, { id: `canc:${pendingId}`, title: 'Cancelar' }]
    : [{ id: `ccero:${pendingId}`, title: 'Confirmar' }, { id: `canc:${pendingId}`, title: 'Cancelar' }];
}

export const BUTTON_ID = /^(ctot|ccero|canc):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function resultText(r) {
  const d = r.documents ?? {};
  const lines = [r.repeated ? 'ℹ️ Este despacho ya estaba confirmado.' : '✅ ¡Despacho confirmado!', `Orden de cargue: ${d.ordenCargue ?? '—'}`, `Remesa: ${d.remesa ?? '—'}`, `Manifiesto: ${d.manifiesto ?? '—'}`];
  if (d.transferencia) lines.push(`Transferencia: ${d.transferencia}`);
  lines.push(r.rndc?.migrated ? `Ministerio: radicado ${r.rndc.radicado}` : r.rndc ? 'Ministerio: sin migrar todavía (puede tardar).' : 'Ministerio: estado no verificado.');
  return lines.join('\n');
}
