// M7.2: the single summary of a prepared batch, written by CODE from what Silogtran actually matched (never by the model).
const clean = (v, n = 60) => String(v ?? '—').replace(/[\u0000-\u001f*_~`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const money = (n) => `$${Number(n).toLocaleString('es-CO')}`;
const when = (c) => {
  const d = new Date(`${c.fecha}T${String(c.hora).length === 5 ? `${c.hora}:00` : c.hora}-05:00`);
  if (Number.isNaN(d.getTime())) return `${c.fecha} ${c.hora}`;
  return `${d.toLocaleDateString('es-CO', { timeZone: 'America/Bogota', weekday: 'short', day: 'numeric', month: 'short' })} ${d.toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: 'numeric', minute: '2-digit', hour12: true })}`;
};

export function advanceLine(r) {
  if (r.eleccion) return r.eleccion.anticipo > 0 ? `Anticipo ${money(r.eleccion.anticipo)} a ${clean(r.eleccion.beneficiario.texto, 40)}` : 'Anticipo cero';
  if (r.loteAnticipo === 'total') return `Anticipo total ${money(r.anticipoSugerido)}`;
  return 'Anticipo cero';
}

// items: rows of ia_lote_items (ordered); pendings: Map(pendiente id -> resumen). Returns the message text.
export function loteSummaryText(items, pendings) {
  const ready = items.filter((i) => i.status === 'READY');
  const lines = [`📋 Lote preparado: ${ready.length} de ${items.length} ${items.length === 1 ? 'despacho listo' : 'despachos listos'}`, ''];
  for (const it of items) {
    const placa = clean(it.input?.placa, 10);
    if (it.status === 'READY') {
      const r = pendings.get(it.pendiente_id);
      if (!r) { lines.push(`${it.n}. ⚠️ Solicitud ${it.numero} · ${placa}: no pude leer el resumen.`); continue; }
      lines.push(
        `${it.n}. ✅ Solicitud ${it.numero}${it.input?.item ? ` ítem ${it.input.item}` : ''} · ${placa}`,
        `   ${clean(r.solicitud?.origen, 25)} → ${clean(r.solicitud?.destino, 25)} · Conductor: ${clean(r.conductor, 35)}`,
        `   Cargue: ${when(r.fechas.citaCargue)} · Descargue: ${when(r.fechas.citaDescargue)}`,
        `   ${advanceLine(r)}${r.pesoKilos ? ` · ${Number(r.pesoKilos).toLocaleString('es-CO')} kg` : ''}`,
      );
    } else {
      lines.push(`${it.n}. ❌ Solicitud ${it.numero} · ${placa}: ${clean(it.error_text || 'no se pudo preparar.', 200)}`);
    }
  }
  lines.push('', ready.length
    ? 'Todavía no se grabó nada en Silogtran. La confirmación del lote llega en el siguiente paso; lo preparado vence en 15 minutos.'
    : 'Ninguna fila quedó lista. Corrige lo marcado y mándame la tabla otra vez.');
  return lines.join('\n').slice(0, 3800);
}

// Button ids of a batch: lprep = prepare it, lcan = cancel it.
export const LOTE_BUTTON = /^(lprep|lcan):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const loteButtons = (id, { valid, bad }) => [
  { id: `lprep:${id}`, title: bad > 0 ? 'Preparar válidas' : 'Preparar lote' },
  { id: `lcan:${id}`, title: 'Cancelar lote' },
].slice(0, valid > 0 ? 2 : 0);
