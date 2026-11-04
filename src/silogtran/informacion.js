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

async function selectVehicle(form, placa) {
  const name = need(form, `${P}vehiculo_codigo_seleccion_activo`);
  const attr = 'ctl0_mainmodule_vehiculo_codigo_seleccion_activo';
  const plate = String(placa || '').trim().toUpperCase();
  if (!plate) throw new ApiError('INVALID_PARAMETER', 'Falta la placa del vehículo.', { status: 400 });
  const results = await form.suggest(name, plate);
  if (!results.length) {
    throw new ApiError('VEHICLE_NOT_ACTIVE', `El vehículo ${plate} no está activo o no está registrado en Silogtran.`, { status: 404 });
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

export async function fillInformacion(form, { placa, origen, destino, tipoManifiesto, now }) {
  const vehiculo = await selectVehicle(form, placa); // must come before the route (anticipo depends on it)
  const ruta = await selectRoute(form, origen, destino);
  const fechas = await setDatesAndVolume(form, now);
  const tipo = setManifestType(form, tipoManifiesto, defaultManifestType(origen, destino));
  return { vehiculo, ruta, fechas, tipoManifiesto: tipo };
}
