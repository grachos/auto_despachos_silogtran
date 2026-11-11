// Vehicle activation screen (Maestros.Vehiculo.Activar_111), READ side. Flow verified with browser captures:
//   1. CAutoComplete `vehiculo_codigo` with the plate -> vehicle id in `vehiculo_codigo$IDHidden`;
//   2. «Buscar Items»: a plain submit (empty PRADO_POSTBACK_TARGET, `boton_buscaritem=Buscar Items`) fills the grid `ItemsVehiculo`;
//   3. (not here) tick the row's `activar` checkbox and post «Aceptar» (PRADO_POSTBACK_TARGET=ctl0$MainModule$Aceptar).
// `estado_codigo` on this screen is a SEARCH FILTER (left empty), not the state to set.
import * as cheerio from 'cheerio';
import { PradoPage } from './prado.js';
import { ApiError } from '../http/errors.js';
import { cell, norm } from './text.js';

const PAGE = 'index.php?page=Maestros.Vehiculo.Activar_111';
const P = 'ctl0$MainModule$';
const GRID = /^ctl0\$MainModule\$ItemsVehiculo\$(ctl\d+)\$(\w+)$/;

// Pure: the grid rows from the page HTML. Row fields are inputs named `…$ItemsVehiculo$ctlN$<field>`; the checkbox `activar` is only
// submitted when ticked, so it is read from the HTML, not from the submitted fields.
export function parseActivationGrid(html) {
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
    } else row.fields[field] = cell(el.attribs.value ?? $(el).text());
    rows.set(ctl, row);
  });
  return [...rows.values()].map((r) => ({
    ctl: r.ctl, item: r.fields.item ?? '', placa: r.fields.nombre ?? '', estado: r.fields.estado ?? '',
    conductor: r.fields.conductor ?? '', poseedor: r.fields.poseedor ?? '', propietario: r.fields.propietario ?? '', observacion: r.fields.observacion ?? '',
    checkbox: r.checkbox, checked: r.checked, fields: Object.keys(r.fields),
  }));
}

// Pure: the EventTarget/name of the «Aceptar» and «Buscar Items» buttons and any message area, from the page HTML.
export function parseActivationControls(html) {
  const $ = cheerio.load(String(html));
  const buttons = $('input[type=submit], input[type=button], button, a[id]').toArray()
    .filter((el) => /aceptar|buscar/i.test(`${el.attribs.id ?? ''} ${el.attribs.name ?? ''} ${el.attribs.value ?? ''}`))
    .map((el) => ({ id: el.attribs.id ?? null, name: el.attribs.name ?? null, value: cell(el.attribs.value ?? $(el).text()).slice(0, 40) || null }));
  const messages = $('[id]').toArray()
    .filter((el) => /mensaje|message|error|resultado/i.test(el.attribs.id) && !/^(input|select|textarea|form|script)$/i.test(el.tagName))
    .map((el) => ({ id: el.attribs.id, text: cell($(el).text()).slice(0, 300) }))
    .filter((m) => m.text);
  return { buttons, messages };
}

// Searches one plate: autocomplete (exact match on the plate) -> «Buscar Items». Read-only: nothing is ticked or accepted.
// Returns { form, pick, rows } or throws PLATE_NOT_FOUND / AMBIGUOUS_OPTION. Runs inside client.enqueue().
export async function searchVehicleItems(client, placa) {
  const plate = String(placa ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,10}$/.test(plate)) throw new ApiError('INVALID_PARAMETER', 'Placa inválida.', { status: 400 });
  const form = new PradoPage(client, await client.request(PAGE));
  if (!(`${P}vehiculo_codigo` in form.fields)) throw new ApiError('FORM_FIELD_MISSING', 'La pantalla de activación de vehículos no tiene el campo de placa.', { status: 502 });
  const suggestions = await form.suggest(`${P}vehiculo_codigo`, plate);
  const attr = 'ctl0_mainmodule_vehiculo_codigo'; // attribute names are the lowercase control ids
  const exact = suggestions.filter((s) => norm(s.attrs[attr] ?? s.cells[0] ?? '') === norm(plate));
  if (!exact.length) throw new ApiError('PLATE_NOT_FOUND', `No encontré la placa ${plate} en el módulo de activación de Silogtran.`, { status: 404 });
  if (exact.length > 1) throw new ApiError('AMBIGUOUS_OPTION', `Hay varias coincidencias para la placa ${plate}; no se activa nada.`, { status: 409 });
  const pick = exact[0];
  form.select(pick);
  // Same as the browser capture: plain submit with the button's name=value and the button locks on.
  await form.postback('', {
    PRADO_POSTBACK_PARAMETER: '', [`${P}boton_buscaritem`]: 'Buscar Items',
    [`${P}IDLockHidden_ctl0_MainModule_boton_buscaritem`]: 'true', [`${P}IDLockHidden_ctl0_MainModule_Aceptar`]: 'true',
  });
  return { form, pick, rows: parseActivationGrid(form.html) };
}

// READ-ONLY diagnostic of the activation screen for a plate: what the autocomplete returned, the grid rows and the controls. Never ticks nor accepts.
export async function inspectVehicleActivation(client, placa) {
  const { form, pick, rows } = await searchVehicleItems(client, placa);
  const controls = parseActivationControls(form.html);
  return {
    ok: true,
    sugerencia: { atributos: Object.keys(pick.attrs), id: pick.attrs.ctl0_mainmodule_vehiculo_codigo_idhidden ?? null },
    // person names are reported only as filled/empty, like the other diagnostics
    filas: rows.map((r) => ({
      ctl: r.ctl, item: r.item, placa: r.placa, estado: r.estado, casilla: r.checkbox, marcada: r.checked, campos: r.fields,
      conductor: Boolean(r.conductor), poseedor: Boolean(r.poseedor), propietario: Boolean(r.propietario), observacion: Boolean(r.observacion),
    })),
    botones: controls.buttons, mensajes: controls.messages,
    estadoFiltro: form.fields[`${P}estado_codigo`] ?? null,
  };
}
