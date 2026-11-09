// "Which requests can I dispatch?": reads the dispatch viewer (Visor_105) once, keeps the requests that still have free slots, filters them
// (number, Silogtran user, route, client, product, vehicle type) and builds the WhatsApp text. Read-only: nothing is confirmed or saved.
// The viewer's "Vehiculos" column is "requested/dispatched" (10/1 = 10 requested, 1 already dispatched -> 9 free; 2/2 is complete).
import * as cheerio from 'cheerio';
import { ApiError } from '../http/errors.js';
import { norm, cell } from './text.js';

const VISOR_PAGE = 'index.php?page=Despacho.Solicitudtransporte.Visor_105';
export const MAX_SHOWN = 10;
const MAX_TEXT = 3800; // WhatsApp text limit is 4096

export function parseVisorList(html) {
  const $ = cheerio.load(String(html));
  if (!norm($('h2').first().text()).includes('visor solicitud')) {
    throw new ApiError('VISOR_UNEXPECTED_PAGE', 'Silogtran no mostró el visor de solicitudes.', { status: 502 });
  }
  const rows = $('#ctl0_MainModule_visor tr').toArray();
  if (!rows.length) return [];
  const headers = $(rows[0]).find('th').toArray().map((th) => norm($(th).text()));
  const at = (pred) => headers.findIndex(pred);
  const col = {
    numero: at((h) => h === 'solicitud'), item: at((h) => h === 'item'), fechaCargue: at((h) => h === 'fecha cargue'),
    cliente: at((h) => h === 'cliente'), origen: at((h) => h === 'origen'), destino: at((h) => h === 'destino'), producto: at((h) => h === 'producto'),
    vehiculos: at((h) => h === 'vehiculos'), clase: at((h) => h.startsWith('clase')), flete: at((h) => h.startsWith('flete')), usuario: at((h) => h === 'usuario'),
  };
  if (col.numero < 0 || col.vehiculos < 0) throw new ApiError('VISOR_PARSE_FAILED', 'No se pudo leer la tabla del visor de Silogtran.', { status: 502 });
  return rows.slice(1)
    .map((tr) => $(tr).children('td').toArray().map((td) => cell($(td).text())))
    .filter((tds) => tds.length >= headers.length)
    .map((tds) => {
      const get = (k) => (col[k] >= 0 ? tds[col[k]] : '');
      const v = /(\d+)\s*\/\s*(\d+)/.exec(get('vehiculos'));
      const total = v ? Number(v[1]) : 0;
      const despachados = v ? Number(v[2]) : 0;
      const parts = (s) => s.split('/').map((x) => x.trim()).filter(Boolean);
      const clase = parts(get('clase'));
      const flete = parts(get('flete'));
      return {
        numero: get('numero'), item: Number(get('item')) || 0, fechaCargue: get('fechaCargue'),
        cliente: get('cliente'), origen: get('origen'), destino: get('destino'), producto: get('producto'),
        total, despachados, cupos: Math.max(total - despachados, 0),
        vehiculo: clase.slice(0, 2).join(' / '), // class / body, without the model year
        tipoFlete: flete.length ? flete[flete.length - 1] : '', usuario: get('usuario'),
      };
    })
    .filter((r) => r.numero);
}

// One GET of the viewer (all pending requests come in one page). Runs inside client.enqueue().
export async function readVisorList(client) {
  const page = await client.request(VISOR_PAGE);
  return parseVisorList(page.text);
}

// All words of the filter must appear (accent/case-insensitive) in the field.
const has = (field, term) => {
  const words = norm(term).split(' ').filter(Boolean);
  const f = norm(field);
  return words.every((w) => f.includes(w));
};

const clean = (v) => { const s = String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80); return s || null; };
export const cleanFilters = (a = {}) => ({
  numero: String(a.numero ?? '').replace(/\D/g, '').slice(0, 20) || null,
  usuario: clean(a.usuario), origen: clean(a.origen), destino: clean(a.destino), cliente: clean(a.cliente), producto: clean(a.producto), vehiculo: clean(a.vehiculo),
});

// Only requests with free slots; then the filters; own requests first (the assistant's user), then the soonest loading date.
export function filterList(rows, f, miUsuario) {
  const mine = norm(miUsuario);
  const out = rows.filter((r) => r.cupos > 0
    && (!f.numero || r.numero.includes(f.numero))
    && (!f.usuario || has(r.usuario, f.usuario))
    && (!f.origen || has(r.origen, f.origen))
    && (!f.destino || has(r.destino, f.destino))
    && (!f.cliente || has(r.cliente, f.cliente))
    && (!f.producto || has(r.producto, f.producto))
    && (!f.vehiculo || has(r.vehiculo, f.vehiculo)));
  const own = (r) => (mine && norm(r.usuario) === mine ? 0 : 1);
  return out.sort((a, b) => own(a) - own(b) || String(a.fechaCargue).localeCompare(String(b.fechaCargue)) || a.numero.localeCompare(b.numero) || a.item - b.item);
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const DAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
export function shortDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(s ?? ''));
  if (!m) return '—';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${DAYS[d.getUTCDay()]} ${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}${m[4] ? ` ${m[4]}:${m[5]}` : ''}`;
}

// Client names carry the tax id at the end («MABE COLOMBIA S.A.S 6068968300»): not shown.
const tidyName = (s) => String(s ?? '').replace(/\s+\d{6,}\s*$/, '').trim() || '—';
const esc = (s) => String(s ?? '').replace(/[*_~`]/g, ' '); // keep WhatsApp formatting characters out of the data

function filtersLabel(f) {
  const parts = [];
  if (f.numero) parts.push(`número ${f.numero}`);
  if (f.usuario) parts.push(`usuario ${f.usuario}`);
  if (f.origen || f.destino) parts.push(`ruta ${f.origen ?? 'cualquiera'} → ${f.destino ?? 'cualquiera'}`);
  if (f.cliente) parts.push(`cliente ${f.cliente}`);
  if (f.producto) parts.push(`producto ${f.producto}`);
  if (f.vehiculo) parts.push(`vehículo ${f.vehiculo}`);
  return parts.length ? parts.join(' · ') : 'sin filtros';
}

export function buildListText(matches, f, miUsuario) {
  const label = filtersLabel(f);
  if (!matches.length) {
    return `No encontré solicitudes con cupos libres (${esc(label)}). Prueba con otro cliente, ruta, producto o tipo de vehículo, o dime el número de la solicitud.`;
  }
  const mine = norm(miUsuario);
  const lines = (r, i) => [
    `${i + 1}. *${r.numero}* · ítem ${r.item} · cargue ${shortDate(r.fechaCargue)} · quedan ${r.cupos} de ${r.total}${mine && norm(r.usuario) === mine ? ' · ⭐ tuya' : ''}`,
    `   ${esc(tidyName(r.cliente))}`,
    `   ${esc(r.origen)} → ${esc(r.destino)} · ${esc(r.producto)}`,
    `   ${esc(r.vehiculo || '—')} · flete ${esc(r.tipoFlete || '—')} · usuario ${esc(r.usuario || '—')}`,
  ].join('\n');
  const shown = matches.slice(0, MAX_SHOWN);
  const head = (n) => `📋 *Solicitudes con cupos libres* (${esc(label)})\n${matches.length > n ? `Muestro ${n} de ${matches.length}; las tuyas van primero.` : `${matches.length} encontrada${matches.length === 1 ? '' : 's'}.`}`;
  const foot = '\n\nDime el número de la que quieres despachar, la placa y las citas de cargue y descargue.';
  let text;
  let n = shown.length;
  for (;;) { // keep it under WhatsApp's limit
    text = `${head(n)}\n\n${shown.slice(0, n).map(lines).join('\n\n')}${matches.length > n ? '\n\nHay más: afina por cliente, ruta, producto, usuario o tipo de vehículo.' : ''}${foot}`;
    if (text.length <= MAX_TEXT || n <= 1) break;
    n -= 1;
  }
  return text;
}
