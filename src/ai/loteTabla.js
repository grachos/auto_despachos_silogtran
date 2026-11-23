// M7: fixed-format table reader. The person pastes a header row + one line per dispatch (tab, ; or | separated);
// this is parsed by CODE (no model), so plates and dates are never misread. Free text falls back to the model (registrar_lote).
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ALIASES = {
  solicitud: 'solicitud', numero: 'solicitud', nsolicitud: 'solicitud', nrosolicitud: 'solicitud', numerosolicitud: 'solicitud',
  item: 'item', placa: 'placa', cargue: 'cargue', citacargue: 'cargue', descargue: 'descargue', citadescargue: 'descargue',
  anticipo: 'anticipo', beneficiario: 'beneficiario', observacion: 'observacion', observaciones: 'observacion', observaciondespacho: 'observacion',
  fuente: 'fuente', contenedor: 'contenedor', bl: 'bl', manifiesto: 'tipoManifiesto', tipomanifiesto: 'tipoManifiesto', operacion: 'tipoOperacion', tipooperacion: 'tipoOperacion',
};
const REQUIRED = [['solicitud', 'Solicitud'], ['placa', 'Placa'], ['cargue', 'Cargue'], ['descargue', 'Descargue'], ['anticipo', 'Anticipo']];

function splitLine(line, delim) { return line.split(delim).map((c) => c.trim()); }
function pickDelimiter(line) {
  let best = null; let n = 0;
  for (const d of ['\t', ';', '|', ',']) { const c = line.split(d).length - 1; if (c > n) { best = d; n = c; } }
  return best;
}

export function parseDateTime(cell) {
  const s = String(cell ?? '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])?\.?m?\.?$/i.exec(s);
  let y, mo, d, h, mi, ap;
  if (m) [, y, mo, d, h, mi, ap] = m;
  else if ((m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})[ T](\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])?\.?m?\.?$/i.exec(s))) [, d, mo, y, h, mi, ap] = m;
  else throw new Error('use fecha y hora así: AAAA-MM-DD HH:mm (ejemplo 2026-11-25 08:00).');
  h = Number(h);
  if (ap) { if (h < 1 || h > 12) throw new Error('hora no válida.'); h = (h % 12) + (ap.toLowerCase() === 'p' ? 12 : 0); }
  const fecha = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const t = new Date(`${fecha}T00:00:00Z`);
  if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== fecha || h > 23 || Number(mi) > 59) throw new Error('fecha u hora no válida.');
  return { fecha, hora: `${String(h).padStart(2, '0')}:${mi}` };
}

function parseAnticipo(cell) {
  const s = String(cell ?? '').trim();
  if (!s) return null;
  if (['cero', 'sinanticipo'].includes(norm(s))) return 0;
  if (['total', 'completo', 'todo'].includes(norm(s))) return 'total';
  const digits = s.replace(/[$\s.,]/g, '');
  if (/^\d{1,12}$/.test(digits)) return Number(digits);
  throw new Error('escribe «cero», «total» o el valor en pesos (ejemplo 500000).');
}

function parseBeneficiario(cell) {
  const t = norm(cell);
  if (!t) return null;
  if (/^cond|^chofer/.test(t)) return 'conductor';
  if (/^pose|^propie|^duen/.test(t)) return 'poseedor';
  throw new Error('escribe «conductor» o «poseedor».');
}

// «columna X: …» (two words before the colon, so the later prefix cleanup keeps it).
function inColumn(name, fn) {
  try { return fn(); } catch (e) { throw new Error(`columna ${name}: ${e.message}`); }
}

const opt = (v) => (String(v ?? '').trim() === '' ? null : String(v).trim());

// Returns { kind: 'none' } (not a fixed-format table), { kind: 'header_error', error }, or { kind: 'table', rows }.
// Each row has the same shape as the registrar_lote rows; a row with a bad cell carries __error (shown as ❌, others unaffected).
export function parseTabla(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let h = -1; let delim = null; let cols = null;
  for (let i = 0; i < Math.min(lines.length, 6); i++) {
    const d = pickDelimiter(lines[i]);
    if (!d) continue;
    const names = splitLine(lines[i], d).map((c) => ALIASES[norm(c)] ?? null);
    if (names.includes('solicitud') && names.includes('placa')) { h = i; delim = d; cols = names; break; }
  }
  if (h < 0) return { kind: 'none' };
  const missing = REQUIRED.filter(([k]) => !cols.includes(k)).map(([, label]) => label);
  if (missing.length) return { kind: 'header_error', error: `A la tabla le falta la columna ${missing.join(', ')}.` };
  const rows = [];
  for (const line of lines.slice(h + 1)) {
    const cells = splitLine(line, delim);
    const get = (k) => { const i = cols.indexOf(k); return i >= 0 ? (cells[i] ?? '') : ''; };
    const raw = { numero: get('solicitud').replace(/\D/g, ''), item: null, placa: get('placa').toUpperCase().replace(/[\s-]/g, ''), citaCargue: null, citaDescargue: null, tipoManifiesto: opt(get('tipoManifiesto')), tipoOperacion: opt(get('tipoOperacion')), fuente: opt(get('fuente')), observacionDespacho: opt(get('observacion')), contenedor: opt(get('contenedor')), bl: opt(get('bl')), beneficiario: null, anticipo: null };
    try {
      if (cells.length > cols.length) throw new Error(`la fila tiene más columnas (${cells.length}) que el encabezado (${cols.length}). Revisa que ningún texto lleve «${delim === '\t' ? 'tabulador' : delim}».`);
      const it = get('item');
      if (it) { if (!/^\d{1,3}$/.test(it)) throw new Error('columna Item: debe ser un número.'); raw.item = Number(it); }
      raw.citaCargue = inColumn('Cargue', () => parseDateTime(get('cargue'))); // a bad cell is reported with the column that failed
      raw.citaDescargue = inColumn('Descargue', () => parseDateTime(get('descargue')));
      raw.anticipo = inColumn('Anticipo', () => parseAnticipo(get('anticipo')));
      raw.beneficiario = inColumn('Beneficiario', () => parseBeneficiario(get('beneficiario')));
    } catch (e) {
      raw.__error = String(e.message || e);
    }
    rows.push(raw);
  }
  if (!rows.length) return { kind: 'header_error', error: 'No encontré filas de despacho debajo del encabezado.' };
  return { kind: 'table', rows };
}

// Free text that looks like several dispatches (2+ distinct request numbers) but is not in the fixed format.
export const looksLikeBatch = (text) => new Set(String(text ?? '').match(/\b01\d{8}\b/g) ?? []).size >= 2;
