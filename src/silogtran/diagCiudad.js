// READ-ONLY diagnostic: where does Silogtran keep the municipality (DANE / DIVIPOLA code) of a request's origin and destination?
// Goal: decide «urbano/municipal» by MUNICIPALITY instead of by name (DON DIEGO is inside SANTA MARTA: same municipality, MAN157).
// Opens the request form (same search as buscarSolicitud) and reports: city/place-related controls (name, type, value, chosen option),
// the item table's headers + city cells + any hidden inputs/links inside the rows, and menu links to city/place/route masters.
// Never posts anything but the search; returns no personal data (city/place names and codes only).
import * as cheerio from 'cheerio';
import { formFields } from './client.js';

const SEARCH_PAGE = 'index.php?page=Despacho.Solicitudtransporte.Buscar';
const P = 'ctl0$MainModule$';
const CITY = /ciudad|origen|destino|municipio|dane|divipola|lugar|sitio|depart/i;
const clip = (s, n = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function inspectCityData(html) {
  const $ = cheerio.load(html);
  const controles = [];
  $('input, select, textarea').each((_, el) => {
    const name = $(el).attr('name') ?? '';
    const id = $(el).attr('id') ?? '';
    if (!CITY.test(name) && !CITY.test(id)) return;
    const type = el.tagName === 'select' ? 'select' : ($(el).attr('type') ?? el.tagName);
    const c = { name: name.replace(P, ''), id, type };
    if (type === 'select') {
      const o = $(el).find('option[selected]').first();
      c.valor = clip(o.attr('value')); c.texto = clip(o.text()); c.opciones = $(el).find('option').length;
    } else c.valor = clip($(el).attr('value'));
    controles.push(c);
  });
  const rows = $('#ctl0_MainModule_ItemsSolicitudtransporte tr').toArray();
  const headers = rows.length ? $(rows[0]).find('th').toArray().map((th) => clip($(th).text(), 40)) : [];
  const cityCols = headers.map((h, i) => (CITY.test(h) ? i : -1)).filter((i) => i >= 0);
  const filas = rows.slice(1, 4).map((tr) => {
    const tds = $(tr).children('td').toArray();
    return {
      celdas: Object.fromEntries(cityCols.map((i) => [headers[i], clip($(tds[i]).text(), 60)])),
      ocultos: $(tr).find('input[type="hidden"]').toArray().map((h) => ({ name: ($(h).attr('name') ?? '').replace(P, ''), valor: clip($(h).attr('value'), 40) })).filter((h) => CITY.test(h.name)),
      enlaces: $(tr).find('a[href]').toArray().map((a) => clip($(a).attr('href'), 160)).filter((h) => CITY.test(h)),
    };
  });
  const menu = [...new Map($('a[href*="page="]').toArray()
    .map((a) => ({ texto: clip($(a).text(), 60), page: (/page=([^&"']+)/.exec($(a).attr('href') ?? '') ?? [])[1] ?? '' }))
    .filter((l) => /ciudad|municipio|lugar|divipola|dane|ruta|sitio/i.test(`${l.texto} ${l.page}`))
    .map((l) => [l.page, l])).values()].slice(0, 40);
  return { controles, tabla: { headers, columnasCiudad: cityCols.map((i) => headers[i]), filas }, menu };
}

export async function diagCity(client, numero) {
  const page = await client.request(SEARCH_PAGE);
  const { form, data } = formFields(page.text);
  const btn = `${P}ctl1`;
  Object.assign(data, { [`${P}soltra_codigo`]: numero, PRADO_POSTBACK_TARGET: btn, [btn]: 'Buscar' });
  const res = await client.request(new URL(form.attr('action') || SEARCH_PAGE, page.url).href, { method: 'POST', form: data });
  const title = clip(cheerio.load(res.text)('h2').first().text(), 80);
  return { numero, titulo: title, ...inspectCityData(res.text) };
}
