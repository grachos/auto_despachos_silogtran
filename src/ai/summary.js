// Confirmation text and buttons built by CODE from the structured summary Silogtran returned
// (never paraphrased by the model): what the person confirms is what Silogtran actually matched.
const when = (fecha, hora) => {
  const d = new Date(`${fecha}T${String(hora).length === 5 ? hora + ':00' : hora}-05:00`);
  return Number.isNaN(d.getTime()) ? `${fecha} ${hora}` : d.toLocaleString('es-CO', { timeZone: 'America/Bogota', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
};
const money = (n) => `$${Number(n).toLocaleString('es-CO')}`;
const clean = (v) => String(v ?? '—').replace(/[\u0000-\u001f]/g, ' ').slice(0, 80);

const span = (t) => `${Number(t?.horas) || 0} h${Number(t?.minutos) ? ` ${Number(t.minutos)} min` : ''}`;

export function buildSummaryText(r, { footer } = {}) {
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
  lines.push('', footer ?? 'Revisa que todo esté bien y elige una opción. No se graba nada hasta que pulses un botón de confirmar.');
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

// `withLink:false` leaves the PDF link out of the text (it goes in its own «Imprimir manifiesto» button).
export function resultText(r, resumen, { withLink = true } = {}) {
  const d = r.documents ?? {};
  const lines = [r.repeated ? 'ℹ️ Este despacho ya estaba confirmado.' : '✅ ¡Despacho confirmado!', `Orden de cargue: ${d.ordenCargue ?? '—'}`, `Remesa: ${d.remesa ?? '—'}`, `Manifiesto: ${d.manifiesto ?? '—'}`];
  if (d.transferencia) lines.push(`Transferencia: ${d.transferencia}`);
  if (resumen) lines.push(`Cargado por: ${fuenteLabel(resumen.fuente)}`);
  if (withLink && d.manifiestoPdf) lines.push(`📄 Manifiesto en PDF: ${d.manifiestoPdf}`);
  if (r.ministerio !== 'NO_APLICA') lines.push(r.rndc?.migrated ? `Ministerio: radicado ${r.rndc.radicado}` : 'Ministerio: verificando el radicado… te aviso por aquí en un momento.');
  return lines.join('\n');
}

// Why a pressed button / confirmation is not usable, and how each confirm error ends the pending row (shared by WhatsApp and the MCP).
export const EXPLAIN = {
  PROCESSING: 'Ya estoy procesando tu confirmación; espera unos segundos.',
  USED: 'Ese despacho ya fue confirmado.',
  CANCELLED: 'Ese despacho fue cancelado.',
  SUPERSEDED: 'Ese resumen ya no está vigente: pediste otro después. Usa los botones del más reciente.',
  EXPIRED: 'Ese resumen venció (dura 15 minutos). ¿Lo preparo de nuevo con los mismos datos?',
  NOT_FOUND: 'No encontré ese despacho. Pídemelo de nuevo.',
};

// Confirm errors: deterministic text and the final state of the pending row (default: back to PENDING so the button can be tapped again).
export const CONFIRM_ERRORS = {
  ANTICIPO_CHANGED: { text: 'El anticipo cambió desde que preparé el resumen. ¿Lo preparo de nuevo para ver el valor actualizado?', final: 'SUPERSEDED', again: true },
  TOKEN_EXPIRED: { text: 'El resumen venció (dura 15 minutos). ¿Lo preparo de nuevo con los mismos datos?', final: 'SUPERSEDED', again: true },
  TOKEN_INVALID: { text: 'No pude validar ese resumen. ¿Lo preparo de nuevo con los mismos datos?', final: 'SUPERSEDED', again: true },
  USER_BUSY: { text: 'Hay otra operación tuya en curso; espera unos segundos y vuelve a pulsar el botón.' },
  SOLICITUD_LOCKED: { text: 'Esa solicitud se está procesando ahora mismo; espera unos segundos y vuelve a pulsar el botón.' },
  CONFIRMATION_IN_PROGRESS: { text: 'Esa confirmación ya está en proceso; espera unos segundos y vuelve a pulsar el botón.' },
  CONFIRMATION_UNKNOWN: { text: 'No puedo confirmar si Silogtran guardó el despacho. Revísalo en Silogtran antes de repetirlo.', final: 'USED' },
  SAVE_RESULT_UNKNOWN: { text: 'No puedo confirmar si Silogtran guardó el despacho. Revísalo en Silogtran antes de repetirlo.', final: 'USED' },
  SAVE_REJECTED: { text: 'Silogtran no guardó el despacho. Revisa los datos y pídemelo de nuevo.', final: 'USED' },
  RELINK_REQUIRED: { text: 'Tu usuario o contraseña de Silogtran ya no son válidos. Pide un link nuevo al administrador y vuelve a ingresar.', final: 'SUPERSEDED' },
  CREDENTIALS_INVALID: { text: 'Tu usuario o contraseña de Silogtran ya no son válidos. Pide un link nuevo al administrador y vuelve a ingresar.', final: 'SUPERSEDED' },
};
