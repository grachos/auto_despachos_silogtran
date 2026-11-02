// Dispatch viewer flow (steps 2-3 of the dispatch flow): clear pending -> find the request row ->
// Confirmar -> "Continuar confirmacion" -> tick genera_manifiesto. Does NOT save anything.
// Pending items live in the Silogtran session, so every run starts by clearing them.
// Functions here run inside client.enqueue() callers and must not enqueue themselves.
import * as cheerio from 'cheerio';
import { formFields, isLoginPage } from './client.js';
import { ApiError } from '../http/errors.js';
import { norm, cell, int } from './text.js';

const VISOR_PAGE = 'index.php?page=Despacho.Solicitudtransporte.Visor_105';
const P = 'ctl0$MainModule$';
const MANIFEST_ID = 'ctl0_MainModule_porConfirmar_ctl0_genera_manifiesto';

const fail = (code, message, detail, status = 502) => new ApiError(code, message, { status, detail });

// Posts the current page's form with extra fields (always to the form action of that response).
async function post(client, page, fields) {
  const { form, data } = formFields(page.text);
  Object.assign(data, fields);
  return client.request(new URL(form.attr('action') || page.url, page.url).href, { method: 'POST', form: data });
}

function assertLoggedIn(page) {
  if (isLoginPage(page.text)) {
    throw fail('SILOGTRAN_SESSION_EXPIRED', 'La sesión en Silogtran expiró; intenta de nuevo.', undefined, 503);
  }
}

function assertVisor(page) {
  assertLoggedIn(page);
  if (!norm(cheerio.load(page.text)('h2').first().text()).includes('visor solicitud')) {
    throw fail('VISOR_UNEXPECTED_PAGE', 'Silogtran no mostró el visor de solicitudes.', `url=${page.url}`);
  }
}

// EventTarget of a PRADO link, from its JS init; falls back to id with '_' -> '$'.
const eventTarget = (html, id) => new RegExp(`'ID':'${id}','EventTarget':'([^']+)'`).exec(html)?.[1] ?? id.replaceAll('_', '$');

function tableRows($, selector) {
  const rows = $(`${selector} tr`).toArray();
  if (!rows.length) return { headers: [], data: [] };
  const headers = $(rows[0]).find('th').toArray().map((th) => norm($(th).text()));
  const data = rows
    .slice(1)
    .map((tr) => ({ tr, tds: $(tr).children('td').toArray() }))
    .filter((r) => r.tds.length >= headers.length);
  return { headers, data };
}

// Removes pending confirmations from the session; returns the (clean) viewer page.
export async function clearPending(client) {
  let page = await client.request(VISOR_PAGE);
  assertVisor(page);
  if (!cheerio.load(page.text)('#ctl0_MainModule_limpiar').length) return page;
  page = await post(client, page, { [`${P}limpiar`]: 'Quitar Todos', PRADO_POSTBACK_TARGET: `${P}limpiar` });
  assertVisor(page);
  if (cheerio.load(page.text)('#ctl0_MainModule_limpiar').length) {
    throw fail('PENDING_NOT_CLEARED', 'No se pudieron limpiar las solicitudes pendientes en Silogtran.');
  }
  return page;
}

function findVisorRow(page, numero, item) {
  const $ = cheerio.load(page.text);
  const { headers, data } = tableRows($, '#ctl0_MainModule_visor');
  const iSol = headers.indexOf('solicitud');
  const iItem = headers.indexOf('item');
  if (iSol < 0 || iItem < 0) return { missing: true, rows: data.length, headers };
  for (const { tr, tds } of data) {
    if (cell($(tds[iSol]).text()) !== numero || int($(tds[iItem]).text()) !== item) continue;
    const link = $(tr).find('a').toArray().find((a) => norm($(a).text()) === 'confirmar');
    if (!link) return { missing: true, rows: data.length, headers, noLink: true };
    return { target: eventTarget(page.text, $(link).attr('id')) };
  }
  return { missing: true, rows: data.length, headers };
}

// Picks which item of the request to dispatch (the one with free vehicles).
export function pickItem(solicitud, wanted) {
  if (wanted != null) {
    const it = solicitud.items.find((i) => i.item === wanted);
    if (!it) throw new ApiError('ITEM_NOT_FOUND', `La solicitud ${solicitud.numero} no tiene el ítem ${wanted}.`, { status: 404 });
    if (it.pendientes <= 0) throw new ApiError('NO_PENDING_VEHICLES', `El ítem ${wanted} no tiene vehículos pendientes por despachar.`, { status: 409 });
    return it;
  }
  const open = solicitud.items.filter((i) => i.pendientes > 0);
  if (!open.length) throw new ApiError('NO_PENDING_VEHICLES', `La solicitud ${solicitud.numero} no tiene vehículos pendientes por despachar.`, { status: 409 });
  if (open.length > 1) {
    throw new ApiError('AMBIGUOUS_OPTION', 'La solicitud tiene varios ítems con vehículos pendientes; indica cuál (campo item).', {
      status: 409,
      extra: { options: open.map((i) => ({ item: i.item, origen: i.origen, destino: i.destino, pendientes: i.pendientes })) },
    });
  }
  return open[0];
}

export async function startDispatch(client, { numero, item, fechaCreacion }) {
  let page = await clearPending(client);

  // The viewer has no request-number filter: narrow by creation date when the form exposes it.
  const dateField = `${P}soltra_fechacreacion`;
  if (fechaCreacion && dateField in formFields(page.text).data) {
    page = await post(client, page, { [dateField]: fechaCreacion, PRADO_POSTBACK_TARGET: `${P}ctl1`, [`${P}ctl1`]: 'Buscar' });
    assertVisor(page);
  }

  const row = findVisorRow(page, numero, item);
  if (row.missing) {
    throw fail(
      'SOLICITUD_NOT_IN_VISOR',
      `La solicitud ${numero} (ítem ${item}) no aparece en el visor de Silogtran.`,
      `rows=${row.rows} headers=${(row.headers || []).join('|')} noLink=${Boolean(row.noLink)}`,
      404,
    );
  }

  // Confirmar on the row -> pending list on the same page.
  page = await post(client, page, { PRADO_POSTBACK_TARGET: row.target, PRADO_POSTBACK_PARAMETER: '' });
  assertVisor(page);
  let $ = cheerio.load(page.text);
  const pending = tableRows($, '#ctl0_MainModule_porConfirmar');
  const iSol = pending.headers.indexOf('solicitud');
  const iItem = pending.headers.indexOf('item');
  const onlyOurs =
    pending.data.length === 1 &&
    cell($(pending.data[0].tds[iSol]).text()) === numero &&
    int($(pending.data[0].tds[iItem]).text()) === item;
  if (!$('#ctl0_MainModule_confirmar').length || !onlyOurs) {
    throw fail('CONFIRM_STEP_FAILED', 'Silogtran no dejó la solicitud como pendiente de confirmar.', `pendingRows=${pending.data.length}`);
  }

  // "Continuar confirmacion" -> server redirects to Confirmar_111 (followed by request()).
  page = await post(client, page, { [`${P}confirmar`]: 'Continuar confirmacion', PRADO_POSTBACK_TARGET: `${P}confirmar` });
  assertLoggedIn(page);
  if (!cheerio.load(page.text)(`#${MANIFEST_ID}`).length) {
    throw fail('CONFIRM_STEP_FAILED', 'No se abrió la pantalla de confirmación de Silogtran.', `url=${page.url}`);
  }

  // Tick genera_manifiesto (autopostback): orden de cargue and remesa get ticked and locked by Silogtran.
  const manifestName = `${P}porConfirmar$ctl0$genera_manifiesto`;
  page = await post(client, page, { [manifestName]: 'on', PRADO_POSTBACK_TARGET: manifestName });
  assertLoggedIn(page);
  $ = cheerio.load(page.text);
  const locked = (suffix) => {
    const el = $(`#ctl0_MainModule_porConfirmar_ctl0_genera_${suffix}`);
    return el.is('[checked]') && el.is('[disabled]');
  };
  const state = {
    manifiesto: $(`#${MANIFEST_ID}`).is('[checked]'),
    ordenCargue: locked('orden'),
    remesa: locked('remesa'),
    informacionDespacho: norm($('body').text()).includes('informacion despacho'),
  };
  if (!state.manifiesto || !state.ordenCargue || !state.remesa) {
    throw fail('MANIFEST_STEP_FAILED', 'Silogtran no marcó el manifiesto con orden de cargue y remesa.', JSON.stringify(state));
  }
  return { page, state };
}
