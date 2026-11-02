// Read-only lookup of a transport request (Despacho.Solicitudtransporte.Buscar -> form).
import * as cheerio from 'cheerio';
import { formFields } from './client.js';
import { ApiError } from '../http/errors.js';

const SEARCH_PAGE = 'index.php?page=Despacho.Solicitudtransporte.Buscar';
const P = 'ctl0$MainModule$';

const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const cell = (s) => String(s ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
const int = (s) => Number.parseInt(String(s).replace(/[^\d-]/g, ''), 10) || 0;

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

  return { numero, requiereContenedor: contenedor, items };
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
