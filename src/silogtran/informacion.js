// "Informacion Despacho" block (steps 4-7): vehicle, route (-> anticipo), dates, manifest type.
// Fills the form only; nothing is saved.
import { ApiError } from '../http/errors.js';
import { norm } from './text.js';
import { bogotaNow, addDays } from './dates.js';

const P = 'ctl0$MainModule$';
export const need = (form, name) => {
  if (!(name in form.fields)) {
    throw new ApiError('FORM_FIELD_MISSING', 'La pantalla de Silogtran no tiene un campo esperado.', { status: 502, detail: name });
  }
  return name;
};
export const parseMoney = (s) => {
  const n = Number(String(s ?? '').replace(/[^\d.]/g, ''));
  return String(s ?? '').trim() && Number.isFinite(n) ? n : null;
};

// Read-only: affiliate type of the loaded vehicle (hidden tipafi_codigo: 1 EXTERNO, 2 INTERNO; 3 EMPRESA is never
// used), the anticipo beneficiary options and the auto-selected operation type.
const AFILIADO = { 1: 'EXTERNO', 2: 'INTERNO', 3: 'EMPRESA' };
export function readAfiliado(form) {
  const $ = form.$();
  const code = form.value('ctl0_MainModule_tipafi_codigo') || ($('#ctl0_MainModule_tipafi_codigo option[selected]').attr('value') ?? '').trim();
  const bene = $('select[name="ctl0$MainModule$tercero_beneficiario_anticipo"] option')
    .toArray()
    .map((o) => ({ id: (o.attribs.value ?? '').trim(), texto: $(o).text().replace(/\s+/g, ' ').trim(), seleccionado: o.attribs.selected !== undefined }))
    .filter((o) => o.id !== '')
    .map((o) => ({ ...o, rol: /POSEEDOR|PROPIETARIO/i.test(o.texto) ? 'poseedor' : /CONDUCTOR/i.test(o.texto) ? 'conductor' : 'otro' }));
  const op = $('select[name="ctl0$MainModule$tipo_operacion"] option[selected]');
  return {
    tipoAfiliado: AFILIADO[code] ?? null,
    beneficiarios: bene,
    tipoOperacion: op.length ? { codigo: (op.attr('value') ?? '').trim(), nombre: op.text().trim() } : null,
  };
}

// "Confirmado Por" (ctl0$MainModule$confirmado_por: "SELECCIONE UNO" | "EMPRESA" | "NORMAL"; no validator) is never chosen
// by the person: the Silogtran UI fills it from the tab used to load the vehicle (Vehículos Activos -> NORMAL, Empresas ->
// EMPRESA) in the browser, which an HTTP client does not replicate. We always set it explicitly, and again right before
// "Grabar" (later postbacks re-render the page). If the field is missing we fail BEFORE saving.
export const CONFIRMADO_POR = 'ctl0$MainModule$confirmado_por';

// PRADO TTabPanel: `new Prado.WebUI.TTabPanel({"ID":..., "Views":[...]})` + hidden input `<ID>_1` = active view index.
// The browser updates it when the person clicks a tab; an HTTP client never does, so the server keeps thinking the
// first tab ("Vehículos Activos") is active. Finds the panel whose view contains `controlName` and marks that view active.
export function tabPanels(form) {
  const out = [];
  for (const m of String(form.html ?? '').matchAll(/TTabPanel\(\s*(\{[\s\S]*?\})\s*\)/g)) {
    let o = null;
    try { o = JSON.parse(m[1]); } catch { /* tolerate non-JSON option literals */ }
    const id = o?.ID ?? /['"]ID['"]\s*:\s*['"]([^'"]+)/.exec(m[1])?.[1];
    const views = o?.Views ?? [...(/['"]Views['"]\s*:\s*\[([^\]]*)\]/.exec(m[1])?.[1] ?? '').matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
    if (!id || !views.length) continue;
    const hiddenName = form.ids?.get(`${id}_1`.toLowerCase()) ?? null;
    out.push({ id, views, hiddenName, active: hiddenName ? form.fields[hiddenName] ?? null : null });
  }
  return out;
}
export function activateTabOf(form, controlName) {
  const $ = form.$();
  for (const p of tabPanels(form)) {
    const index = p.views.findIndex((v) => $(`#${v}`).find(`[name="${controlName}"]`).length > 0);
    if (index >= 0 && p.hiddenName && p.hiddenName in form.fields) {
      form.fields[p.hiddenName] = String(index);
      form.activeTab = { name: p.hiddenName, value: String(index) };
      return form.activeTab;
    }
  }
  return null;
}
export function setConfirmadoPor(form, fuente = 'activos') {
  if (!(CONFIRMADO_POR in form.fields)) {
    throw new ApiError('CONFIRMED_BY_FIELD_MISSING', 'No encontré el campo "Confirmado Por" de Silogtran; no se grabó nada.', { status: 502 });
  }
  const opt = resolveOption(selectOptions(form, CONFIRMADO_POR), fuente === 'empresas' ? 'EMPRESA' : 'NORMAL', 'Confirmado Por');
  form.fields[CONFIRMADO_POR] = opt.value;
  // Keep the Empresas tab marked active across later postbacks (they re-render the page).
  if (fuente === 'empresas' && form.activeTab && form.activeTab.name in form.fields) form.fields[form.activeTab.name] = form.activeTab.value;
  return opt.value;
}

// Alternative vehicle source, ONLY when the person asks for it (fuente="empresas"): "Empresas" tab (pre-registered vehicle+trailer+driver combos of an affiliated company).
// Type the plate, pick the exact combo, press "Aceptar" (ValidationGroup RequeridosEmpresa). The affiliate type
// (tipafi_codigo) is filled by Silogtran with the vehicle's real value, same as the other source.
async function selectFromEmpresas(form, plate) {
  const notFound = () => new ApiError('VEHICLE_NOT_ACTIVE', `La placa ${plate} no apareció en la pestaña Empresas. Posibles causas: la placa o alguno de sus terceros (conductor, poseedor, propietario o remolque) está inactivo, o el afiliado de la placa (interno/externo) no corresponde al de la solicitud.`, { status: 404 });
  const name = `${P}vehiculo_placa_empresa`;
  if (!(name in form.fields)) throw notFound();
  const attr = 'ctl0_mainmodule_vehiculo_placa_empresa';
  const exact = (await form.suggest(name, plate)).filter((r) => norm(r.attrs[attr]) === norm(plate));
  if (!exact.length) throw notFound();
  if (exact.length > 1) {
    throw new ApiError('AMBIGUOUS_OPTION', `Hay varios registros de "${plate}" en la pestaña Empresas (distinto remolque o conductor).`, {
      status: 409,
      extra: { options: exact.map((r) => ({ placa: r.attrs[attr], remolque: r.attrs.ctl0_mainmodule_trailer_placa_empresa, conductor: `${r.attrs.ctl0_mainmodule_tercero_nombre1 ?? ''} ${r.attrs.ctl0_mainmodule_tercero_apellido1 ?? ''}`.trim() })) },
    });
  }
  const pick = exact[0];
  form.select(pick);
  activateTabOf(form, name); // the server may derive "Confirmado Por" from the ACTIVE tab, not from the posted select
  // Mirror the browser exactly (captured 2026-11-04): "Aceptar" is a plain submit -> empty PRADO_POSTBACK_TARGET, the
  // button's own name=value, its IDLock set to "true" and the Empresas tab index (enturnamiento_1 = 1). Never resolve the
  // button by ValidationGroup: other buttons of that tab (e.g. "Crear usuario conductor") share "RequeridosEmpresa".
  const button = `${P}Aceptar_empresa`;
  const lock = `${P}IDLockHidden_ctl0_MainModule_Aceptar_empresa`;
  await form.postback('', { [button]: 'Aceptar', ...(lock in form.fields ? { [lock]: 'true' } : {}) });
  const filled = form.value('ctl0_MainModule_vehiculo_codigo');
  if (!filled) throw new ApiError('VEHICLE_SELECT_FAILED', 'Silogtran no cargó los datos del vehículo desde la pestaña Empresas.', { status: 502, detail: plate });
  return {
    ...readAfiliado(form),
    placa: filled,
    clase: pick.attrs.ctl0_mainmodule_claveh_nombre || null,
    carroceria: pick.attrs.ctl0_mainmodule_carroceria_nombre || null,
    trailer: form.value('ctl0_MainModule_trailer_codigo') || pick.attrs.ctl0_mainmodule_trailer_placa_empresa || null,
    conductor: form.value('ctl0_MainModule_tercero_codigo_conductor') || null,
    fuente: 'empresas',
  };
}

export async function selectVehicle(form, placa, fuente = 'activos') {
  const name = need(form, `${P}vehiculo_codigo_seleccion_activo`);
  const attr = 'ctl0_mainmodule_vehiculo_codigo_seleccion_activo';
  const plate = String(placa || '').trim().toUpperCase();
  if (!plate) throw new ApiError('INVALID_PARAMETER', 'Falta la placa del vehículo.', { status: 400 });
  if (fuente === 'empresas') return selectFromEmpresas(form, plate);
  const results = await form.suggest(name, plate);
  if (!results.length) {
    throw new ApiError('VEHICLE_NOT_ACTIVE', `La placa ${plate} no apareció en Vehículos Activos. Posibles causas: la placa o alguno de sus terceros (conductor, poseedor, propietario o remolque) está inactivo, o el afiliado de la placa (interno/externo) no corresponde al de la solicitud. Si querías despachar por la pestaña Empresas, indícalo.`, { status: 404 });
  }
  const exact = results.filter((r) => norm(r.attrs[attr]) === norm(plate));
  const pick = exact.length === 1 ? exact[0] : results.length === 1 ? results[0] : null;
  if (!pick) {
    throw new ApiError('AMBIGUOUS_OPTION', `Hay varios vehículos para "${plate}"; indica la placa exacta.`, {
      status: 409,
      extra: { options: results.map((r) => ({ placa: r.attrs[attr], clase: r.attrs.ctl0_mainmodule_claveh_nombre, conductor: r.attrs.ctl0_mainmodule_tercero_codigo_conductor })) },
    });
  }
  form.select(pick);
  await form.postback(`${P}buscar_activo`, { [`${P}buscar_activo`]: 'Seleccionar' });
  const filled = form.value('ctl0_MainModule_vehiculo_codigo');
  if (!filled) {
    throw new ApiError('VEHICLE_SELECT_FAILED', 'Silogtran no cargó los datos del vehículo seleccionado.', { status: 502, detail: plate });
  }
  return {
    ...readAfiliado(form),
    placa: filled,
    clase: pick.attrs.ctl0_mainmodule_claveh_nombre || null,
    carroceria: pick.attrs.ctl0_mainmodule_carroceria_nombre || null,
    trailer: form.value('ctl0_MainModule_trailer_codigo') || null,
    conductor: form.value('ctl0_MainModule_tercero_codigo_conductor') || pick.attrs.ctl0_mainmodule_tercero_codigo_conductor || null,
  };
}

async function selectRoute(form, origen, destino) {
  const name = need(form, `${P}ruta_codigo`);
  const label = `${origen} - ${destino}`;
  const results = await form.suggest(name, `${origen}%${destino}`);
  const attr = 'ctl0_mainmodule_ruta_codigo';
  const exact = results.filter((r) => norm(r.attrs[attr]) === norm(label));
  if (!exact.length) {
    throw new ApiError('ROUTE_NOT_FOUND', `No existe en Silogtran la ruta "${label}".`, {
      status: 404,
      extra: results.length ? { options: results.map((r) => String(r.attrs[attr]).replace(/\s+/g, ' ').trim()) } : undefined,
    });
  }
  if (exact.length > 1) throw new ApiError('AMBIGUOUS_OPTION', `Hay varias rutas "${label}" en Silogtran.`, { status: 409 });
  form.select(exact[0]);
  // The browser fires change callbacks (ctl25/ctl26) that compute freight/anticipo.
  for (const t of form.triggers('ctl0_MainModule_ruta_codigo', 'change', [`${P}ctl25`, `${P}ctl26`])) await form.callback(t);
  const anticipoTexto = form.fields[need(form, `${P}Anticipo`)];
  const anticipo = parseMoney(anticipoTexto);
  if (anticipo === null) {
    throw new ApiError('ANTICIPO_NOT_CALCULATED', 'Silogtran no calculó el anticipo para esta ruta y vehículo.', { status: 502 });
  }
  return { ruta: label, tipoRuta: exact[0].attrs.ctl0_mainmodule_tipo_ruta || null, anticipoSugerido: anticipo };
}

async function setDatesAndVolume(form, now) {
  const salida = bogotaNow(now);
  const entrega = addDays(salida.fecha, 5);
  const values = {
    fecha_salida: salida.fecha,
    hora_salida: salida.hora,
    fecha_limiteentrega: entrega,
    hora_limiteentrega: salida.hora,
    fecha_limitecumplido: addDays(entrega, 5),
    soltra_volumengalontanqueado: '0',
  };
  for (const [k, v] of Object.entries(values)) form.fields[need(form, P + k)] = v;
  for (const t of form.triggers('ctl0_MainModule_soltra_volumengalontanqueado', 'blur', [`${P}ctl35`])) await form.callback(t);
  return { salida: `${salida.fecha} ${salida.hora}`, limiteEntrega: `${entrega} ${salida.hora}`, limiteCumplido: values.fecha_limitecumplido };
}

export function resolveOption(options, input, label) {
  const wanted = norm(input);
  const exact = options.filter((o) => norm(o.value) === wanted || norm(o.text) === wanted);
  const found = exact.length ? exact : options.filter((o) => norm(o.text).includes(wanted));
  if (found.length === 1) return found[0];
  throw new ApiError(found.length ? 'AMBIGUOUS_OPTION' : 'OPTION_NOT_FOUND', `${found.length ? 'Varias opciones coinciden' : 'Ninguna opción coincide'} con "${input}" para ${label}.`, {
    status: found.length ? 409 : 400,
    extra: { options: (found.length ? found : options).map((o) => ({ codigo: o.value, nombre: o.text })) },
  });
}

export function selectOptions(form, name) {
  const $ = form.$();
  return $(`select[name="${name}"] option`)
    .toArray()
    .map((o) => ({ value: (o.attribs.value ?? '').trim(), text: $(o).text().trim() }))
    .filter((o) => o.value !== '');
}

// Business rule: same origin and destination city -> 6 (VIAJE MUNICIPAL O URBANO), otherwise 1 (MANIFIESTO GENERAL).
// Only a default: an explicit tipoManifiesto always wins.
export const defaultManifestType = (origen, destino) => (norm(origen) === norm(destino) ? '6' : '1');

function setManifestType(form, input, defaultCode) {
  const name = need(form, `${P}tipmanrndc_codigo`);
  const opt = resolveOption(selectOptions(form, name), input ?? defaultCode, 'el tipo de manifiesto');
  form.fields[name] = opt.value;
  return { codigo: opt.value, nombre: opt.text };
}

// "Tipo de operación" is auto-selected by Silogtran when a vehicle is loaded from "Vehículos Activos" (TERCEROS for externals)
// but stays on "SELECCIONE UNO" when loaded from the Empresas tab, and saving then fails with a generic server error.
// Verified at the END of the fill (the route may also set it). EXTERNO -> TERCEROS (what Silogtran itself picks for them);
// anything else is NOT guessed: fail early with the available options.
export async function ensureTipoOperacion(form, tipoAfiliado) {
  const name = `${P}tipo_operacion`;
  if (!(name in form.fields)) return null;
  const options = selectOptions(form, name);
  const isEmpty = (v) => { const o = options.find((x) => x.value === String(v ?? '').trim()); return !o || /seleccione/i.test(o.text); };
  const current = options.find((o) => o.value === String(form.fields[name] ?? '').trim());
  if (!isEmpty(form.fields[name])) return { codigo: current.value, nombre: current.text };
  if (tipoAfiliado !== 'EXTERNO') {
    throw new ApiError('OPERATION_TYPE_MISSING', 'Silogtran no seleccionó el tipo de operación para este vehículo y no puedo elegirlo por ti.', {
      status: 409, extra: { options: options.map((o) => ({ codigo: o.value, nombre: o.text })) },
    });
  }
  const opt = resolveOption(options, 'TERCEROS', 'el tipo de operación');
  form.fields[name] = opt.value;
  for (const t of form.triggers('ctl0_MainModule_tipo_operacion', 'change', [])) await form.callback(t);
  return { codigo: opt.value, nombre: opt.text };
}

export async function fillInformacion(form, { placa, fuente, origen, destino, tipoManifiesto, now }) {
  const vehiculo = await selectVehicle(form, placa, fuente); // must come before the route (anticipo depends on it)
  const ruta = await selectRoute(form, origen, destino);
  const fechas = await setDatesAndVolume(form, now);
  const tipo = setManifestType(form, tipoManifiesto, defaultManifestType(origen, destino));
  const tipoOperacion = await ensureTipoOperacion(form, vehiculo.tipoAfiliado);
  const confirmadoPor = setConfirmadoPor(form, fuente);
  return { vehiculo, ruta, fechas, tipoManifiesto: tipo, tipoOperacion, confirmadoPor };
}
