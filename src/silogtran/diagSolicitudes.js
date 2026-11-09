// Read-only diagnostic for "list the requests I can dispatch": reports what the dispatch viewer (Visor_105) and the request search
// screen (Solicitudtransporte.Buscar) really offer: filter controls, table columns, a short sample of rows and pagination hints.
// Nothing is confirmed or saved (no "Confirmar", no "Quitar Todos"); the optional date filter is a plain search postback.
import * as cheerio from 'cheerio';
import { formFields } from './client.js';
import { norm } from './text.js';

const VISOR_PAGE = 'index.php?page=Despacho.Solicitudtransporte.Visor_105';
const BUSCAR_PAGE = 'index.php?page=Despacho.Solicitudtransporte.Buscar';
const P = 'ctl0$MainModule$';
const tidy = (t, n = 60) => String(t ?? '').replace(/[\u0000-\u001f ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// Form controls a person can use as filters (names without the common prefix). Catalog selects list their option texts.
export function controlsOf(html) {
  const $ = cheerio.load(String(html));
  const out = [];
  $('input, select, textarea').each((_, el) => {
    const name = el.attribs.name;
    if (!name || /^PRADO_|PAGESTATE/i.test(name)) return;
    const type = el.tagName === 'input' ? (el.attribs.type || 'text').toLowerCase() : el.tagName;
    const tr = $(el).closest('tr');
    const label = tidy(tr.prev('tr').find('.dataLabelE').first().text() || tr.find('.dataLabelE').first().text(), 50) || null;
    const c = { name: name.replace(P, ''), type, label };
    if (el.tagName === 'select') {
      const opts = $(el).find('option').toArray().map((o) => tidy($(o).text(), 40));
      c.opciones = opts.length;
      if (opts.length <= 25) c.textos = opts;
    }
    out.push(c);
  });
  return out;
}

export function inspectTable(html, selector) {
  const $ = cheerio.load(String(html));
  $('script, style').remove();
  const rows = $(`${selector} tr`).toArray();
  if (!rows.length) return { existe: $(selector).length > 0, headers: [], filas: 0, muestra: [] };
  const headers = $(rows[0]).find('th').toArray().map((th) => tidy($(th).text(), 40));
  const data = rows.slice(1).map((tr) => $(tr).children('td').toArray()).filter((tds) => tds.length >= headers.length);
  return {
    existe: true,
    headers,
    filas: data.length,
    muestra: data.slice(0, 5).map((tds) => tds.map((td) => tidy($(td).text(), 40))),
    // Per-row actions (link/button texts), e.g. "Confirmar".
    acciones: data.slice(0, 1).map((tds) => tds.map((td) => $(td).find('a, input[type=submit], input[type=button]').toArray().map((a) => tidy($(a).text() || a.attribs.value, 30)).filter(Boolean))),
  };
}

// Pagination hints: pager links/text inside the page body ("Siguiente >", "Página 1 de 3", ...).
export function paginationHints(html) {
  const $ = cheerio.load(String(html));
  $('script, style').remove();
  const found = new Set();
  $('a, span, td, input[type=submit], input[type=button]').each((_, el) => {
    const t = tidy($(el).children().length ? '' : ($(el).text() || el.attribs.value), 40);
    if (t && /siguiente|anterior|p[aá]gina|^\d+ de \d+$|^>>?$|^<<?$|ver m[aá]s|total/i.test(t)) found.add(t);
  });
  return [...found].slice(0, 12);
}

export async function inspectSolicitudScreens(client, { fecha } = {}) {
  const out = {};
  let visor = await client.request(VISOR_PAGE);
  if (!norm(cheerio.load(visor.text)('h2').first().text()).includes('visor solicitud')) {
    return { ok: false, code: 'VISOR_UNEXPECTED_PAGE', url: visor.url };
  }
  out.visor = { controles: controlsOf(visor.text), tabla: inspectTable(visor.text, '#ctl0_MainModule_visor'), paginacion: paginationHints(visor.text) };
  // Optional: the same plain "Buscar" postback the dispatch uses, with a creation date (yyyy-mm-dd).
  const dateField = `${P}soltra_fechacreacion`;
  const { form, data } = formFields(visor.text);
  if (fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha) && dateField in data) {
    visor = await client.request(new URL(form.attr('action') || visor.url, visor.url).href, {
      method: 'POST', form: { ...data, [dateField]: fecha, PRADO_POSTBACK_TARGET: `${P}ctl1`, [`${P}ctl1`]: 'Buscar' },
    });
    out.visorConFecha = { fecha, tabla: inspectTable(visor.text, '#ctl0_MainModule_visor'), paginacion: paginationHints(visor.text) };
  }
  const buscar = await client.request(BUSCAR_PAGE);
  out.buscar = { titulo: tidy(cheerio.load(buscar.text)('h2').first().text(), 60), controles: controlsOf(buscar.text) };
  return { ok: true, ...out };
}
