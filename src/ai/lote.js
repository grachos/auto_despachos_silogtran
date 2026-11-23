// M7.1: read a table of several dispatches into validated rows (no Silogtran calls) and echo it back, written by code.
import { parsePreparar } from '../validation.js';
import { createLote } from '../store/lotes.js';

export const formatUrl = () => `${process.env.PUBLIC_BASE_URL || 'https://auto-despachos-silogtran.vercel.app'}/formato-lote`;

export const MAX_LOTE = 5;

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f*_~`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

function bogotaToday(now) {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
}

function when(c) {
  const d = new Date(`${c.fecha}T${c.hora}-05:00`);
  const day = d.toLocaleDateString('es-CO', { timeZone: 'America/Bogota', weekday: 'short', day: 'numeric', month: 'short' });
  const t = d.toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: 'numeric', minute: '2-digit', hour12: true });
  return `${day} ${t}`;
}

// Validates every row on its own; a bad row never blocks the others. Returns { filas: [{ n, ok, numero, input?, error? }], tooMany }.
export function parseLote(rawRows, now = new Date()) {
  const rows = Array.isArray(rawRows) ? rawRows : [];
  const today = bogotaToday(now);
  const seen = new Set();
  const filas = rows.slice(0, MAX_LOTE).map((raw, i) => {
    const n = i + 1;
    // Excel drops the leading zero of request numbers (0101074194 -> 101074194): all of them start with 0101.
    let numero = String(raw?.numero ?? '').replace(/\D/g, '');
    if (/^101\d{6}$/.test(numero)) numero = `0${numero}`;
    try {
      if (raw?.__error) throw new Error(raw.__error);
      if (!/^\d{6,12}$/.test(numero)) throw new Error('falta el número de la solicitud (solo dígitos).');
      const input = parsePreparar({ ...raw, numero: undefined });
      if (input.citaCargue.fecha < today) throw new Error('la cita de cargue ya pasó.');
      if (new Date(`${input.citaDescargue.fecha}T${input.citaDescargue.hora}-05:00`) < new Date(`${input.citaCargue.fecha}T${input.citaCargue.hora}-05:00`)) throw new Error('la cita de descargue es anterior a la de cargue.');
      const ben = raw?.beneficiario == null ? null : norm(raw.beneficiario);
      if (ben !== null && ben !== 'conductor' && ben !== 'poseedor') throw new Error('el beneficiario debe ser conductor o poseedor.');
      let ant = raw?.anticipo ?? null;
      if (typeof ant === 'string') { const a = norm(ant); ant = ['total', 'completo'].includes(a) ? 'total' : ['cero', 'sinanticipo'].includes(a) ? 0 : /^\d{1,12}$/.test(a.replace(/[$.,\s]/g, '')) ? Number(a.replace(/[$.,\s]/g, '')) : ant; }
      // A batch has ONE confirm button (no per-row choice later), so every row carries its advance. Blank = cero (decision of the owner;
      // the echo says so). Internal vehicles: «cero» or «total»; external: «cero», «total» or an amount (+ beneficiary when above zero).
      // Which one applies is checked when the row is prepared.
      const assumed = ant === null;
      if (assumed) ant = 0;
      if (ant !== 'total' && !(Number.isSafeInteger(ant) && ant >= 0)) throw new Error('el anticipo debe ser «cero», «total» o un valor en pesos.');
      const key = `${numero}|${input.item ?? ''}|${input.placa}`;
      if (seen.has(key)) throw new Error('esa misma solicitud, ítem y placa ya está en otra fila.');
      seen.add(key);
      return { n, ok: true, numero, input: { ...input, beneficiario: ben, anticipo: ant, anticipoEnBlanco: assumed } };
    } catch (e) {
      return { n, ok: false, numero, error: String(e?.message || e).replace(/^\s*\w+:\s*/, '').slice(0, 160) };
    }
  });
  return { filas, tooMany: rows.length > MAX_LOTE, received: rows.length };
}

const pesos = (v) => `$${Number(v).toLocaleString('es-CO')}`;

// The echo shown to the person: what was understood, row by row. Nothing here comes from the model's own wording.
export function loteEchoText({ filas, tooMany, received }, { fromModel = false } = {}) {
  const ok = filas.filter((f) => f.ok);
  const lines = [`📋 Esto fue lo que entendí (${filas.length} ${filas.length === 1 ? 'fila' : 'filas'}):`, ''];
  for (const f of filas) {
    if (!f.ok) { lines.push(`${f.n}. ❌ Solicitud ${f.numero || '—'}: ${f.error}`); continue; }
    const i = f.input;
    const parts = [`${f.n}. ✅ Solicitud ${f.numero}${i.item ? ` ítem ${i.item}` : ''} · placa ${clean(i.placa, 10)}`, `   Cargue: ${when(i.citaCargue)} · Descargue: ${when(i.citaDescargue)}`];
    const extra = [];
    if (i.anticipo === 0) extra.push(i.anticipoEnBlanco ? 'anticipo cero (lo dejaste en blanco)' : 'anticipo cero');
    else if (i.anticipo === 'total') extra.push(`anticipo total${i.beneficiario ? ` a ${i.beneficiario}` : ''}`);
    else extra.push(`anticipo ${pesos(i.anticipo)}${i.beneficiario ? ` a ${i.beneficiario}` : ''}`);
    if (i.fuente === 'empresas') extra.push('pestaña Empresas');
    if (i.tipoManifiesto) extra.push(`manifiesto ${clean(i.tipoManifiesto, 30)}`);
    if (i.tipoOperacion) extra.push(`operación ${clean(i.tipoOperacion, 30)}`);
    if (i.contenedor) extra.push(`contenedor ${clean(i.contenedor, 20)}${i.bl ? ` BL ${clean(i.bl, 20)}` : ''}`);
    if (i.observacionDespacho) extra.push(`obs. despacho: ${clean(i.observacionDespacho, 60)}`);
    if (extra.length) parts.push(`   ${extra.join(' · ')}`);
    lines.push(parts.join('\n'));
  }
  if (tooMany) lines.push('', `⚠️ Mandaste ${received} filas y el máximo por lote es ${MAX_LOTE}: solo leí las primeras ${MAX_LOTE}. Envía el resto en otro lote.`);
  const anyBad = filas.some((f) => !f.ok);
  if (anyBad || fromModel) lines.push('', `${anyBad ? '⚠️ Revisa el formato de la tabla' : 'Para que lea exacto, usa el formato fijo'}: ${formatUrl()}`);
  lines.push('', ok.length
    ? `Todavía no preparé nada en Silogtran: esto es solo la lectura. Si hay algo mal, mándame la tabla corregida. El anticipo en blanco se toma como cero. Se aplica al preparar: en vehículos internos solo cero o total; en externos también un valor con su beneficiario.`
    : 'Ninguna fila quedó lista. Corrige lo marcado y mándame la tabla otra vez.');
  return lines.join('\n').slice(0, 3800);
}

// Shared by the fixed-format reader and the model's registrar_lote: validate, save the valid rows, return the echo text.
export async function saveLote({ userId, rawRows, userText, fromModel, services = { createLote } }) {
  const parsed = parseLote(rawRows);
  if (!parsed.filas.length) return { result: { ok: false, code: 'EMPTY_BATCH' }, reply: `No encontré filas de despacho en tu mensaje. Mándame una línea por despacho con solicitud, placa y las citas de cargue y descargue. Formato: ${formatUrl()}` };
  if (parsed.filas.some((f) => f.ok)) await services.createLote(userId, { filas: parsed.filas.filter((f) => f.ok), texto: userText });
  return { result: { ok: true, filas: parsed.filas.length, validas: parsed.filas.filter((f) => f.ok).length }, reply: loteEchoText(parsed, { fromModel }) };
}

export const headerErrorText = (error) => `⚠️ ${error}\n\nLa tabla debe llevar la primera línea con los títulos: Solicitud;Item;Placa;Cargue;Descargue;Anticipo;Beneficiario;Observacion (Solicitud, Placa, Cargue y Descargue son obligatorias; Anticipo = cero, total o valor en pesos, en blanco = cero; fechas AAAA-MM-DD HH:mm).\n\nFormato y ejemplo para copiar: ${formatUrl()}`;
