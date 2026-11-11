// Third-party activation screen (Maestros.Tercero.Activar_111). Same shape as the vehicle screen (activar.js), verified with browser captures:
//   1. CAutoComplete `tercero_codigo` (typed text, `;<documento>` searches by document) -> id in `tercero_codigo$IDHidden`;
//   2. «Buscar Items»: plain submit (empty PRADO_POSTBACK_TARGET, `boton_buscaritem=Buscar Items`) fills the grid `ItemsTercero` (ONE row per PERSON);
//   3. tick the row's `activar` checkbox and post «Grabar» (PRADO_POSTBACK_TARGET=ctl0$MainModule$grabar, PARAMETER=undefined).
// `estado_codigo` and `caumod_codigo` («Causa Módulo») are left empty (search filter / cause). The «Consultar Log en SAP» button is never sent.
// A refusal (missing documents) appears in `#ctl0_MainModule_mensajeImagenesCargadas`, the same parser as vehicles (parseActivationError).
import * as cheerio from 'cheerio';
import { PradoPage } from './prado.js';
import { ApiError } from '../http/errors.js';
import { cell, norm } from './text.js';
import { parseActivationError, parseActivationControls } from './activar.js';

const PAGE = 'index.php?page=Maestros.Tercero.Activar_111';
const P = 'ctl0$MainModule$';
const GRID = /^ctl0\$MainModule\$ItemsTercero\$(ctl\d+)\$(\w+)$/;
const digits = (s) => String(s ?? '').replace(/\D/g, '');

// Pure: grid rows. The checkbox `activar` is read from the HTML (only submitted when ticked).
export function parseThirdPartyGrid(html) {
  const $ = cheerio.load(String(html));
  const rows = new Map();
  $('input, select, textarea').each((_, el) => {
    const m = GRID.exec(el.attribs.name ?? '');
    if (!m) return;
    const [, ctl, field] = m;
    const row = rows.get(ctl) ?? { ctl, fields: {}, checkbox: null, checked: false };
    if (field === 'activar') {
      row.checkbox = el.attribs.name;
      row.checked = el.attribs.checked !== undefined;
    } else row.fields[field] = cell(el.attribs.value ?? $(el).find('option[selected]').text() ?? $(el).text());
    rows.set(ctl, row);
  });
  return [...rows.values()].map((r) => ({
    ctl: r.ctl, item: r.fields.item ?? '', nombre: r.fields.nombre ?? '', tipo: r.fields.tipo ?? '', documento: r.fields.documento ?? '', estado: r.fields.estado ?? '',
    checkbox: r.checkbox, checked: r.checked, campos: Object.keys(r.fields),
  }));
}

const attrName = 'ctl0_mainmodule_tercero_codigo'; // suggestion attributes are the lowercase control ids

// Candidates for a document: the autocomplete with `;<documento>`. Returns [{ id, nombre, attrs, cells }]. Runs inside client.enqueue().
export async function findThirdParties(client, documento) {
  const doc = digits(documento);
  if (doc.length < 5 || doc.length > 15) throw new ApiError('INVALID_PARAMETER', 'El documento debe tener entre 5 y 15 dígitos.', { status: 400 });
  const form = new PradoPage(client, await client.request(PAGE));
  if (!(`${P}tercero_codigo` in form.fields)) throw new ApiError('FORM_FIELD_MISSING', 'La pantalla de activación de terceros no tiene el campo de tercero.', { status: 502 });
  const found = await form.suggest(`${P}tercero_codigo`, `;${doc}`);
  return found.map((s) => ({ id: s.attrs[`${attrName}_idhidden`] ?? null, nombre: cell(s.attrs[attrName] ?? s.cells[0] ?? ''), attrs: Object.keys(s.attrs), cells: s.cells }));
}

// «Buscar Items» for a third party, by id (from the vehicle sheet) or by document (autocomplete). Read-only.
// Returns { form, rows } or throws THIRD_PARTY_NOT_FOUND / AMBIGUOUS_OPTION. Runs inside client.enqueue().
export async function searchThirdPartyItems(client, { documento, id } = {}) {
  const form = new PradoPage(client, await client.request(PAGE));
  if (!(`${P}tercero_codigo` in form.fields)) throw new ApiError('FORM_FIELD_MISSING', 'La pantalla de activación de terceros no tiene el campo de tercero.', { status: 502 });
  let pickId = id ? String(id).replace(/\D/g, '') : null;
  if (!pickId) {
    const doc = digits(documento);
    if (doc.length < 5 || doc.length > 15) throw new ApiError('INVALID_PARAMETER', 'El documento debe tener entre 5 y 15 dígitos.', { status: 400 });
    const found = await form.suggest(`${P}tercero_codigo`, `;${doc}`);
    if (!found.length) throw new ApiError('THIRD_PARTY_NOT_FOUND', `No encontré un tercero con el documento ${doc} en Silogtran.`, { status: 404 });
    if (found.length > 1) {
      throw new ApiError('AMBIGUOUS_OPTION', `Hay ${found.length} terceros para el documento ${doc}; indica cuál (no se activa nada).`, {
        status: 409, extra: { candidatos: found.slice(0, 10).map((s) => ({ id: s.attrs[`${attrName}_idhidden`] ?? null, nombre: cell(s.attrs[attrName] ?? s.cells[0] ?? '') })) },
      });
    }
    form.select(found[0]);
    pickId = form.fields[`${P}tercero_codigo$IDHidden`] || null;
  } else {
    form.fields[`${P}tercero_codigo$IDHidden`] = pickId;
    if (!form.fields[`${P}tercero_codigo`]) form.fields[`${P}tercero_codigo`] = String(documento ?? pickId);
  }
  // Same as the browser capture: plain submit with the button's name=value and its lock on («Consultar Log en SAP» is NOT sent).
  await form.postback('', { PRADO_POSTBACK_PARAMETER: '', [`${P}boton_buscaritem`]: 'Buscar Items', [`${P}IDLockHidden_ctl0_MainModule_boton_buscaritem`]: 'true' });
  const rows = parseThirdPartyGrid(form.html);
  return { form, rows, id: pickId };
}

// READ-ONLY diagnostic: candidates for the document, and (when exactly one, or an id is given) the grid and controls. Names/documents are
// returned because the admin typed the document himself; nothing is ticked or accepted.
export async function inspectThirdPartyActivation(client, { documento, id } = {}) {
  if (!id) {
    const candidatos = await findThirdParties(client, documento);
    if (candidatos.length !== 1) return { ok: true, candidatos: candidatos.slice(0, 10).map((c) => ({ id: c.id, nombre: c.nombre, atributos: c.attrs, textos: c.cells.slice(0, 6) })), nota: candidatos.length ? 'Varios candidatos: vuelve a llamar con `id`.' : 'Sin candidatos.' };
  }
  const { form, rows, id: pickId } = await searchThirdPartyItems(client, { documento, id });
  const controls = parseActivationControls(form.html);
  return {
    ok: true, id: pickId,
    filas: rows.map((r) => ({ ctl: r.ctl, item: r.item, nombre: r.nombre, tipo: r.tipo, documento: r.documento, estado: r.estado, casilla: r.checkbox, marcada: r.checked, campos: r.campos })),
    botones: controls.buttons, mensajes: controls.messages, causaModulo: form.fields[`${P}caumod_codigo`] ?? null,
  };
}

const rowAction = (estado) => ({ activo: 'already', inactivo: 'activate', anulado: 'annulled' }[norm(estado)] ?? 'unknown');

// REAL WRITE: activates ONE person. Search -> exactly one row -> tick ONLY `activar` -> «Grabar» -> verify by searching again (state must be ACTIVO).
// Returns { changed, estadoAntes, verified, mensajes, persona }. Runs inside client.enqueue().
export async function activateThirdParty(client, { documento, id } = {}) {
  const { form, rows, id: pickId } = await searchThirdPartyItems(client, { documento, id });
  // Strict: only the row whose item is the id we searched (never "the only row that came back").
  const mine = pickId ? rows.filter((r) => String(r.item) === String(pickId)) : rows;
  if (!mine.length) throw new ApiError('THIRD_PARTY_NOT_FOUND', 'Silogtran no devolvió el tercero en el módulo de activación.', { status: 404 });
  if (mine.length > 1) throw new ApiError('AMBIGUOUS_OPTION', 'Hay varias filas para ese tercero; no se activa nada.', { status: 409 });
  const row = mine[0];
  const persona = row.nombre;
  const action = rowAction(row.estado);
  if (action === 'already') return { changed: false, estadoAntes: 'ACTIVO', verified: true, mensajes: [], persona };
  if (action === 'annulled') throw new ApiError('THIRD_PARTY_ANNULLED', `${persona} está ANULADO en Silogtran; no se activa.`, { status: 409 });
  if (action === 'unknown') throw new ApiError('ROW_STATE_UNKNOWN', `No reconozco el estado «${row.estado}» de ${persona}; no se activa nada.`, { status: 409 });
  if (!row.checkbox) throw new ApiError('ACTIVATE_CHECKBOX_MISSING', 'La fila no trae la casilla «activar»; no se activa nada.', { status: 502 });
  for (const k of Object.keys(form.fields)) if (/\$inactivar$/.test(k)) delete form.fields[k];
  await form.postback(`${P}grabar`, {
    PRADO_POSTBACK_PARAMETER: 'undefined', [row.checkbox]: 'on',
    [`${P}IDLockHidden_ctl0_MainModule_boton_buscaritem`]: 'true', [`${P}IDLockHidden_ctl0_MainModule_grabar`]: 'true',
  });
  const refusal = parseActivationError(form.html);
  if (refusal) {
    const lista = refusal.faltantes.length ? ` Faltan estas imágenes/documentos: ${refusal.faltantes.join(', ')}.` : ` ${refusal.texto}`;
    throw new ApiError('ACTIVATE_NOT_ALLOWED', `Silogtran no permite activar a ${persona}.${lista}`, { status: 422, extra: { faltantes: refusal.faltantes } });
  }
  const mensajes = parseActivationControls(form.html).messages;
  const after = (await searchThirdPartyItems(client, { documento, id: pickId })).rows.find((r) => String(r.item) === String(row.item));
  const verified = after ? norm(after.estado) === 'activo' : null;
  if (verified === false) throw new ApiError('ACTIVATE_NOT_APPLIED', `Silogtran respondió pero ${persona} sigue INACTIVO.`, { status: 422, detail: mensajes.map((m) => m.text).join(' | ').slice(0, 300) || 'sin mensaje' });
  return { changed: true, estadoAntes: 'INACTIVO', verified: verified === true, mensajes, persona };
}
