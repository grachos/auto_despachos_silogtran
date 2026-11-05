// Read-only lookup of a transport request (Despacho.Solicitudtransporte.Buscar -> form).
import * as cheerio from 'cheerio';
import { formFields } from './client.js';
import { ApiError } from '../http/errors.js';
import { norm, cell, int } from './text.js';

const SEARCH_PAGE = 'index.php?page=Despacho.Solicitudtransporte.Buscar';
const P = 'ctl0$MainModule$';

export function parseSolicitud(html, numero) {
  const $ = cheerio.load(html);
  const title = norm($('h2').first().text());
  const isForm = title.includes('formulario de solicitud transporte');

  if (!isForm) {
    // Still on the search screen: either a result list (several matches) or nothing found.
    const inList = $('td')
      .toArray()
      .some((td) => cell($(td).text()) === numero);
    if (inList) {
      throw new ApiError('SOLICITUD_AMBIGUOUS', `La búsqueda de la solicitud ${numero} devolvió varios resultados.`, { status: 409 });
    }
    throw new ApiError('SOLICITUD_NOT_FOUND', `No se encontró la solicitud ${numero}.`, { status: 404 });
  }

  const sel = $(`select[name="${P}soltra_contenedor"] option[selected]`).first();
  const contenedor = norm(sel.attr('value')) === 'si';

  // "Tipo de operación" chosen in the request itself (control name unknown: any select whose name/id mentions "operacion").
  let tipoOperacion = null;
  const opSelects = $('select').toArray().filter((s) => /operacion/i.test(`${s.attribs.name ?? ''} ${s.attribs.id ?? ''}`));
  for (const s of opSelects) {
    const o = $(s).find('option[selected]').first();
    const texto = o.text().trim();
    if (texto && !/^seleccione/i.test(texto)) { tipoOperacion = { campo: (s.attribs.name ?? '').replace(P, ''), valor: (o.attr('value') ?? '').trim(), texto }; break; }
  }
  console.log(`[solicitud] tipo operacion: ${tipoOperacion ? `${tipoOperacion.campo}=${tipoOperacion.texto}` : `none (selects con "operacion": ${opSelects.map((s) => (s.attribs.name ?? '').replace(P, '')).join(',') || 'ninguno'})`}`);

  const rows = $('#ctl0_MainModule_ItemsSolicitudtransporte tr').toArray();
  if (!rows.length) {
    throw new ApiError('SOLICITUD_PARSE_FAILED', 'No se pudo leer la tabla de ítems de la solicitud.', { status: 502 });
  }
  const headers = $(rows[0]).find('th').toArray().map((th) => norm($(th).text()));
  const col = (name) => headers.indexOf(name);
  const need = ['itemsolicitud', 'ciudad origen', 'ciudad destino'];
  if (need.some((h) => col(h) < 0)) {
    throw new ApiError('SOLICITUD_PARSE_FAILED', 'La tabla de ítems no tiene las columnas esperadas.', { status: 502, detail: headers.join(' | ') });
  }

  const items = rows
    .slice(1)
    .map((tr) => $(tr).children('td').toArray().map((td) => cell($(td).text())))
    .filter((tds) => tds.length >= headers.length)
    .map((tds) => {
      const get = (h) => (col(h) >= 0 ? tds[col(h)] : '');
      const vehiculos = int(get('vehiculos'));
      const despachados = int(get('vehiculos despachados'));
      return {
        item: int(get('itemsolicitud')),
        remitente: get('remitente'),
        origen: get('ciudad origen'),
        destinatario: get('destinatario'),
        destino: get('ciudad destino'),
        producto: get('producto'),
        vehiculos,
        vehiculosDespachados: despachados,
        pendientes: Math.max(vehiculos - despachados, 0),
      };
    });

  // Creation date (yyyy-mm-dd) is used to narrow the dispatch viewer, which has no request-number filter.
  const fc = $('input[name$="soltra_fechacreacion"]').first().attr('value') || '';
  const fechaCreacion = /^\d{4}-\d{2}-\d{2}/.exec(fc.trim())?.[0] ?? null;

  return { numero, requiereContenedor: contenedor, fechaCreacion, tipoOperacion, items };
}

export async function buscarSolicitud(client, numero) {
  return client.enqueue(async () => {
    const page = await client.request(SEARCH_PAGE);
    const { form, data } = formFields(page.text);
    const btn = `${P}ctl1`;
    Object.assign(data, { [`${P}soltra_codigo`]: numero, PRADO_POSTBACK_TARGET: btn, [btn]: 'Buscar' });
    const res = await client.request(new URL(form.attr('action') || SEARCH_PAGE, page.url).href, { method: 'POST', form: data });
    return parseSolicitud(res.text, numero);
  });
}
