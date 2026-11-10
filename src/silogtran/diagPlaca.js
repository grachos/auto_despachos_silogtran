// Read-only diagnostic for "does this plate exist / is it active in Silogtran?": replays the vehicle master search
// (Maestros.Vehiculo.Buscar, plate field + search button) and, when the result links to a vehicle record (Maestros.Vehiculo.Home_111),
// reads that record's catalog fields (status, affiliate type, class...). Reports structure and catalog values only: text inputs are
// reported as filled/empty, never with their value. Saves nothing.
import * as cheerio from 'cheerio';
import { formFields } from './client.js';
import { ApiError } from '../http/errors.js';

const BUSCAR = 'index.php?page=Maestros.Vehiculo.Buscar';
const P = 'ctl0$MainModule$';
const tidy = (t, n = 60) => String(t ?? '').replace(/[\u0000-\u001f ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// Every table that has a header row: headers, row count, a short sample and the links of the sample rows.
export function tablesOf(html) {
  const $ = cheerio.load(String(html));
  $('script, style').remove();
  const out = [];
  $('table').each((_, t) => {
    const rows = $(t).find('tr').toArray();
    const head = rows.find((r) => $(r).find('th').length);
    if (!head) return;
    const headers = $(head).find('th').toArray().map((th) => tidy($(th).text(), 40));
    const data = rows.filter((r) => r !== head && $(r).children('td').length >= Math.max(1, headers.length - 1));
    if (!data.length && headers.length < 2) return;
    out.push({
      id: t.attribs.id ?? null,
      headers,
      filas: data.length,
      muestra: data.slice(0, 3).map((r) => $(r).children('td').toArray().map((td) => tidy($(td).text(), 40))),
      enlaces: data.slice(0, 3).map((r) => $(r).find('a[href]').toArray().map((a) => ({ texto: tidy($(a).text(), 30), href: tidy(a.attribs.href, 140) })).slice(0, 4)),
    });
  });
  return out.slice(0, 5);
}

// A vehicle record: selects (catalog value shown) and text inputs (only whether they are filled).
export function recordOf(html) {
  const $ = cheerio.load(String(html));
  $('script, style').remove();
  const title = tidy($('h2').first().text(), 80);
  const selects = [];
  const campos = [];
  $('select, input[type=text], input[type=hidden], textarea').each((_, el) => {
    const name = el.attribs.name;
    if (!name || /^PRADO_|PAGESTATE|IDLockHidden|grabar_uuid|^ctl0\$Page/i.test(name)) return;
    const tr = $(el).closest('tr');
    const label = tidy(tr.prev('tr').find('.dataLabelE').first().text() || tr.find('.dataLabelE').first().text(), 40) || null;
    const short = name.replace(P, '');
    if (el.tagName === 'select') {
      const opts = $(el).find('option').toArray();
      if (opts.length <= 30) selects.push({ campo: short, etiqueta: label, elegido: tidy($(el).find('option[selected]').first().text() || '', 40) || null, opciones: opts.length });
    } else if (el.attribs.type !== 'hidden' || /IDHidden/.test(name)) {
      campos.push({ campo: short, etiqueta: label, lleno: String(el.attribs.value ?? $(el).text() ?? '').trim() !== '' });
    }
  });
  return { title, selects, campos: campos.slice(0, 40) };
}

export async function inspectPlate(client, placa) {
  const out = { placa };
  const page = await client.request(BUSCAR);
  const { form, data } = formFields(page.text);
  const plateField = `${P}vehiculo_placa`;
  if (!(plateField in data)) throw new ApiError('FORM_FIELD_MISSING', 'La pantalla de búsqueda de vehículos no tiene el campo de placa.', { status: 502, detail: plateField });
  out.buscar = { controles: Object.keys(data).filter((k) => !/^PRADO_|IDHidden$/.test(k)).map((k) => k.replace(P, '')).slice(0, 40) };
  // The same request the browser sends: plate + the search link target (ctl3), button locks on.
  const res = await client.request(new URL(form.attr('action') || page.url, page.url).href, {
    method: 'POST',
    form: { ...data, [plateField]: placa, PRADO_POSTBACK_TARGET: `${P}ctl3`, PRADO_POSTBACK_PARAMETER: 'undefined', [`${P}IDLockHidden_ctl0_MainModule_ctl3`]: 'true' },
  });
  out.resultado = { url: String(res.url).replace(/^https?:\/\/[^/]+\//, ''), titulo: tidy(cheerio.load(res.text)('h2').first().text(), 80), tablas: tablesOf(res.text) };
  // A record link in the result list -> open the first one (a plain GET, like the browser's click).
  const href = cheerio.load(res.text)('a[href*="Maestros.Vehiculo.Home"]').first().attr('href');
  if (href) {
    const rec = await client.request(new URL(href, res.url).href);
    out.ficha = { href: tidy(href, 140), ...recordOf(rec.text) };
  } else if (/Maestros\.Vehiculo\.Home/.test(String(res.url))) {
    out.ficha = { href: null, ...recordOf(res.text) };
  }
  return { ok: true, ...out };
}
