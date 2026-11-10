// The ONLY tools the model has. There is deliberately no tool to confirm/save a dispatch.
import { ApiError } from '../http/errors.js';
import { consultSolicitud, prepareDispatch, listSolicitudes, checkPlate } from '../dispatch/service.js';
import { cleanFilters, filterList, buildListText } from '../silogtran/lista.js';
import { createPending } from '../store/ia.js';

const str = (description) => ({ type: 'string', description });
const optStr = (description) => ({ type: ['string', 'null'], description });
const tiempo = (label) => ({
  type: ['object', 'null'], additionalProperties: false, required: ['horas', 'minutos'],
  properties: { horas: { type: 'integer', description: `${label}: horas` }, minutos: { type: 'integer', description: `${label}: minutos (0-59)` } },
  description: `${label} pactado. null si la persona no lo indicó (se usa 2 h 0 min). Nunca lo preguntes.`,
});
const cita = (label) => ({
  type: 'object', additionalProperties: false, required: ['fecha', 'hora'],
  properties: { fecha: str(`${label}: fecha YYYY-MM-DD`), hora: str(`${label}: hora HH:mm en formato 24 h`) },
});

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'listar_solicitudes',
      description: 'Lista las solicitudes de transporte que aún tienen cupos libres (las completas, como 2/2, no salen). Úsala SOLO cuando la persona no recuerda el número, da un número incompleto o pide ver solicitudes por criterio (cliente, ruta, producto, usuario de Silogtran, tipo de vehículo). Todos los filtros son opcionales (null = sin filtro). No modifica nada.',
      strict: true,
      parameters: {
        type: 'object', additionalProperties: false, required: ['numero', 'usuario', 'origen', 'destino', 'cliente', 'producto', 'vehiculo'],
        properties: {
          numero: optStr('Número de solicitud o sus últimos dígitos (ej. «3220»); null si no lo dieron'),
          usuario: optStr('Usuario de Silogtran que creó la solicitud (ej. AECHEVERRI); null si no lo dijeron'),
          origen: optStr('Ciudad de origen; null si no la dijeron'),
          destino: optStr('Ciudad de destino; null si no la dijeron'),
          cliente: optStr('Nombre o parte del nombre del cliente (ej. «tequendama»); null si no lo dijeron'),
          producto: optStr('Producto (ej. «aceite de palma»); null si no lo dijeron'),
          vehiculo: optStr('Tipo de vehículo o carrocería (ej. «tractomula», «tanque»); null si no lo dijeron'),
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_solicitud',
      description: 'Consulta una solicitud de transporte: origen, destino, ítems con vehículos pendientes y si requiere contenedor. No modifica nada.',
      strict: true,
      parameters: { type: 'object', additionalProperties: false, required: ['numero'], properties: { numero: str('Número de la solicitud, solo dígitos') } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'preparar_despacho',
      description: 'Prepara un despacho en Silogtran SIN grabarlo. Si sale bien, el sistema mostrará el resumen con botones para que la persona confirme. Úsala en cuanto tengas los datos obligatorios (solicitud, placa y dos citas); beneficiario y anticipo déjalos en null si la persona no los dijo: el sistema pregunta solo si el vehículo resulta externo. Nunca preguntes por ellos antes.',
      strict: true,
      parameters: {
        type: 'object', additionalProperties: false,
        required: ['numero', 'item', 'placa', 'citaCargue', 'citaDescargue', 'tiempoCargue', 'tiempoDescargue', 'tipoManifiesto', 'ordenCompra', 'observacionOrdenCargue', 'observacionRemesa', 'contenedor', 'bl', 'beneficiario', 'anticipo', 'fuente', 'tipoOperacion'],
        properties: {
          numero: str('Número de la solicitud, solo dígitos'),
          item: { type: ['integer', 'null'], description: 'Ítem de la solicitud; null si solo hay uno' },
          placa: str('Placa del vehículo'),
          citaCargue: cita('Cita de cargue'),
          citaDescargue: cita('Cita de descargue'),
          tiempoCargue: tiempo('Tiempo de cargue'),
          tiempoDescargue: tiempo('Tiempo de descargue'),
          tipoManifiesto: optStr('Tipo de manifiesto (código o nombre); null para usar el valor por defecto'),
          ordenCompra: optStr('Orden de compra; null si no la dieron'),
          observacionOrdenCargue: optStr('Observación de la orden de cargue; null si no la dieron'),
          observacionRemesa: optStr('Observación de la remesa; null si no la dieron'),
          contenedor: optStr('Número de contenedor; null si no aplica'),
          bl: optStr('Número de BL; null si no aplica'),
          fuente: optStr('De dónde cargar el vehículo: "activos" (Vehículos Activos) o "empresas" (pestaña Empresas; úsalo si dicen «viaje empresa», «por empresa» o similar). null si la persona no dijo nada (se usa Vehículos Activos).'),
          tipoOperacion: optStr('Tipo de operación SOLO si la persona lo pidió expresamente (ej. «líquida», «carga seca», «contenedor», «férrea», «terceros»). null si no dijo nada: se usa el de la solicitud. Nunca lo deduzcas'),
          beneficiario: optStr('Solo vehículos externos: "conductor" o "poseedor" (a quién va el anticipo). null si no lo han dicho o no sabes si el vehículo es externo'),
          anticipo: { type: ['integer', 'null'], description: 'Solo vehículos externos: valor del anticipo en pesos (entero, 0 si no habrá anticipo). null si no lo han dicho' },
        },
      },
    },
  },
];

// Errors the model must not improvise about: fixed, deterministic replies.
export const FIXED_REPLIES = {
  USER_BUSY: 'Sigo con una operación anterior tuya en Silogtran; espera unos segundos e intenta de nuevo.',
  RELINK_REQUIRED: 'Tu usuario o contraseña de Silogtran ya no son válidos. Pide un link nuevo al administrador y vuelve a ingresar para poder despachar.',
  CREDENTIALS_INVALID: 'Tu usuario o contraseña de Silogtran ya no son válidos. Pide un link nuevo al administrador y vuelve a ingresar para poder despachar.',
  USER_NOT_ACTIVE: 'Tu cuenta no está activa. Pide un link nuevo al administrador.',
  SILOGTRAN_UNREACHABLE: 'No pude conectarme con Silogtran en este momento. Intenta de nuevo en unos minutos.',
  WAF_FAILED: 'No pude conectarme con Silogtran en este momento. Intenta de nuevo en unos minutos.',
};

const trunc = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, n);

// Affiliate rules at prepare time. EXTERNO: beneficiary (conductor|poseedor, from Silogtran's list) and value (0..calculated)
// are ALWAYS asked, never assumed. INTERNO: nothing to ask (driver is the beneficiary; total/zero via buttons).
// Spanish amounts written in words and/or digits ("trescientos mil", "un millón doscientos mil", "1 millón 200 mil",
// "cuatrocientos noventa y cinco mil", "medio millón") -> every number found in the text.
const UNITS = { cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiun: 21, veintiuno: 21, veintiuna: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90, cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300, cuatrocientos: 400, cuatrocientas: 400, quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600, setecientos: 700, setecientas: 700, ochocientos: 800, ochocientas: 800, novecientos: 900, novecientas: 900 };
export function spanishNumbers(text) {
  const out = [];
  const words = String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/(\d)[.,](?=\d{3}\b)/g, '$1').split(/[^a-z0-9]+/).filter(Boolean);
  let total = 0, cur = 0, any = false;
  const flush = () => { if (any) out.push(total + cur); total = 0; cur = 0; any = false; };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^\d+$/.test(w)) { if (any && cur) flush(); cur += Number(w); any = true; }
    else if (w in UNITS) { cur += UNITS[w]; any = true; }
    else if (w === 'mil' && any) { total += (cur || 1) * 1000; cur = 0; }
    else if (w === 'mil') { total = 1000; any = true; }
    else if (/^millon(es)?$/.test(w)) { total = (total + (cur || 1)) * 1_000_000; cur = 0; any = true; }
    else if (w === 'medio' && /^millon/.test(words[i + 1] ?? '')) { out.push(500_000); i++; }
    else if (w === 'y' && any) continue;
    else if (w === 'de' && any && /^pesos?$/.test(words[i + 1] ?? '')) continue;
    else flush();
  }
  flush();
  return out;
}

const nrm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
// The beneficiary and the value must come from the CURRENT message of the person, never from older turns of the history
// (the model reused «0 a conductor» from an earlier dispatch of the same plate). Checked against the message text itself.
export function statedInMessage(userText, { rol, anticipo, max }) {
  const t = nrm(userText);
  // Prefixes tolerate short/typo forms («posee», «conduc», «propie») and common synonyms.
  const roleOk = rol === 'conductor' ? /\b(cond\w*|chofer|chofe\w*)/.test(t) : /\b(pose\w*|propie\w*|duen\w*)/.test(t);
  let valueOk = false;
  if (anticipo === 0) valueOk = /(^|[^\d])0([^\d]|$)|cero|sin anticipo|ningun|nada/.test(t);
  else {
    if (anticipo === max && /total|completo|todo/.test(t)) valueOk = true;
    if (spanishNumbers(userText).some((n) => n === anticipo || (n < 1000 && n * 1000 === anticipo))) valueOk = true;
    for (const m of t.matchAll(/(\d[\d.,]*)\s*(millon(?:es)?|mil|k)?/g)) {
      const n = Number(m[1].replace(/[.,]/g, ''));
      const mult = m[2]?.startsWith('millon') ? 1_000_000 : m[2] ? 1000 : 1;
      if (n * mult === anticipo || (!m[2] && n * 1000 === anticipo)) valueOk = true;
    }
  }
  return { roleOk, valueOk };
}

export const plateNotFoundText = (placa) => `No encontré la placa ${String(placa).replace(/[^A-Z0-9]/g, '')} en Silogtran. Revisa que esté bien escrita (letras y números) y, si la dictaste por voz, escríbela. Cuando me des la placa correcta sigo con el despacho.`;
const pesos = (n) => `$${Number(n).toLocaleString('es-CO')}`;

// Reads «A cero», «b 500 mil», «b total», «valor total al poseedor» from the CURRENT message: A = conductor, B = poseedor.
// Returns only what it is sure of; amounts are trusted only if the message holds a single number (it may also carry a request number).
export function parseAnticipoReply(userText, max) {
  const t = nrm(userText).trim();
  const out = {};
  const letter = /^([ab])(?=[\s:.,)-]|$)/.exec(t) ?? /(?:^|\s)([ab])\s+(?:cero|total|completo|todo|\d)/.exec(t);
  if (letter) out.rol = letter[1] === 'a' ? 'conductor' : 'poseedor';
  else if (/\b(pose\w*|propie\w*|duen\w*)/.test(t)) out.rol = 'poseedor';
  else if (/\b(cond\w*|chofer|chofe\w*)/.test(t)) out.rol = 'conductor';
  const nums = spanishNumbers(String(userText).replace(/\b0\d{5,}\b/g, ' ')); // request numbers (01…) are not amounts
  // In a short reply the bare words count; inside a long message (the whole dispatch request) they must be tied to «anticipo»
  // so «todo el día» or «ninguna observación» are not read as an amount.
  const short = t.split(/\s+/).length <= 6;
  const totalRe = short ? /\b(total|completo|todo)\b/ : /anticipo\s*(?:es\s*|de\s*|en\s*)?(?:el\s*)?(?:total|completo|todo)\b|\b(?:total|completo)\s+del\s+anticipo/;
  const zeroRe = short ? /\b(cero|sin anticipo|ninguno|nada)\b/ : /anticipo\s*(?:de\s*|en\s*)?(?:cero|0)\b|\bsin\s+anticipo\b|\banticipo\s+ninguno\b/;
  if (totalRe.test(t)) out.anticipo = max;
  else if (zeroRe.test(t)) out.anticipo = 0;
  else if (nums.length === 1 && short) out.anticipo = nums[0] < 1000 && nums[0] > 0 ? nums[0] * 1000 : nums[0];
  return out;
}

// Deterministic question for externals (the model used to ask without the maximum, costing extra turns).
export function askExternalText(max, prefix = '') {
  return `${prefix}Vehículo externo. *Anticipo total = ${pesos(max)}*\n\n¿A quién va el anticipo?\n*A* = conductor\n*B* = poseedor\n\nResponde con la letra y el valor. Ej.: A cero · B 500 mil · B total`;
}

export function chooseExternal(resumen, args, userText) {
  if (resumen.tipoAfiliado !== 'EXTERNO') {
    const asked = args.beneficiario != null || args.anticipo != null;
    return { note: asked ? 'Vehículo interno: el beneficiario es el conductor y el anticipo solo puede ser total o cero (se elige con los botones). Ignoré el beneficiario y el valor pedidos.' : null };
  }
  const max = resumen.anticipoSugerido;
  const opts = (resumen.beneficiarios ?? []).filter((o) => o.rol === 'conductor' || o.rol === 'poseedor');
  const said0 = userText !== undefined ? parseAnticipoReply(userText, max) : {};
  if (said0.rol || said0.anticipo !== undefined) args = { ...args, beneficiario: said0.rol ?? args.beneficiario, anticipo: said0.anticipo ?? args.anticipo };
  const role = String(args.beneficiario ?? '').trim().toLowerCase();
  let ben = opts.find((o) => o.rol === role);
  // Zero anticipo: nothing is paid, so who receives it is irrelevant. Do NOT ask: keep the driver (Silogtran's own default) when the
  // person said «cero» in this message (or no message text is available, e.g. API use).
  let defaulted = false;
  if (!ben && args.anticipo === 0) {
    const stated = userText === undefined || said0.anticipo === 0 || statedInMessage(userText, { rol: 'conductor', anticipo: 0, max }).valueOk;
    const driver = opts.find((o) => o.rol === 'conductor') ?? opts.find((o) => o.seleccionado);
    if (stated && driver) { ben = driver; defaulted = true; }
  }
  const view = { afiliado: 'EXTERNO', beneficiariosDisponibles: opts.map((o) => o.rol), anticipoMaximo: max };
  let falta = [...(ben ? [] : ['beneficiario']), ...(args.anticipo == null ? ['anticipo'] : [])];
  if (!falta.length && userText !== undefined && Number.isSafeInteger(args.anticipo) && args.anticipo >= 0 && args.anticipo <= max) {
    const said = statedInMessage(userText, { rol: ben.rol, anticipo: args.anticipo, max });
    // Parts parsed from the current message by code (said0) are already verified; only the model's own values need checking.
    if (!said.roleOk && !said0.rol && !defaulted) falta.push('beneficiario');
    if (!said.valueOk && said0.anticipo === undefined) falta.push('anticipo');
  }
  if (falta.length) return { reply: askExternalText(max), ask: { ok: true, preparado: false, ...view, falta, instruccion: 'Vehículo EXTERNO: pregunta a la persona lo que falta (a quién va el anticipo y cuánto, de 0 a anticipoMaximo) y vuelve a llamar a preparar_despacho con los mismos datos. No supongas.' } };
  if (!Number.isSafeInteger(args.anticipo) || args.anticipo < 0 || args.anticipo > max) {
    return { reply: askExternalText(max, `Ese valor supera el máximo (${pesos(max)}).\n\n`), ask: { ok: false, preparado: false, code: 'ANTICIPO_EXCEEDS', ...view, message: `El anticipo debe estar entre 0 y ${max} pesos.` } };
  }
  return { eleccion: { beneficiario: { id: ben.id, rol: ben.rol, texto: ben.texto }, anticipo: args.anticipo } };
}

// Deterministic next-step hint for the model after a lookup (it tended to ask "¿quieres despacharla en ese ítem?").
export function nextStep(s) {
  const open = s.items.filter((i) => i.pendientes > 0);
  if (!open.length) return 'La solicitud está AGOTADA: avisa que ya no tiene vehículos por despachar y no sigas.';
  if (open.length === 1) return `Hay un solo ítem con cupos (ítem ${open[0].item}): úsalo. Si ya tienes placa y las dos citas, llama AHORA a preparar_despacho con item ${open[0].item}. NO preguntes si quiere despachar ni en qué ítem, ni por afiliado, beneficiario o anticipo (si el vehículo es externo el sistema lo pregunta después de preparar).`;
  return 'Hay varios ítems con cupos: pregunta SOLO cuál ítem, salvo que la persona ya lo haya indicado.';
}

// Executors bound to the actor (the person linked to this phone). The actor is never a model-controlled argument.
export function makeExecutors({ userId, send, userText, services = { consultSolicitud, prepareDispatch, createPending, listSolicitudes, checkPlate } }) {
  return {
    async listar_solicitudes(args) {
      await send('⏳ Buscando solicitudes en Silogtran…');
      const f = cleanFilters(args);
      const { rows, miUsuario } = await services.listSolicitudes(userId);
      const matches = filterList(rows, f, miUsuario);
      // Only a (partial) number was given and exactly one request matches: let the model continue with it (e.g. «despáchame la 3220 con placa…»).
      const onlyNumber = f.numero && !f.usuario && !f.origen && !f.destino && !f.cliente && !f.producto && !f.vehiculo;
      if (onlyNumber && matches.length === 1) {
        const m = matches[0];
        return { result: { ok: true, coincidencias: 1, solicitud: { numero: m.numero, item: m.item, origen: trunc(m.origen, 40), destino: trunc(m.destino, 40) }, siguiente: 'Es la solicitud que la persona quiso decir: sigue el flujo normal con ese número (consultar_solicitud / preparar_despacho) sin volver a preguntar.' } };
      }
      // Otherwise the answer is written by code (the model never retells the list): it ends the turn.
      return { result: { ok: true, coincidencias: matches.length }, reply: buildListText(matches, f, miUsuario) };
    },
    async consultar_solicitud(args) {
      await send('⏳ Consultando la solicitud en Silogtran…');
      const s = await services.consultSolicitud(userId, args.numero);
      return {
        result: {
          ok: true, numero: s.numero, requiereContenedor: s.requiereContenedor,
          despachable: s.items.some((i) => i.pendientes > 0),
          siguiente: nextStep(s),
          nota: 'vehiculosPorDespachar es solo una CANTIDAD de cupos libres, no una lista de vehículos entre los que elegir.',
          items: s.items.map((i) => ({ item: i.item, origen: trunc(i.origen, 60), destino: trunc(i.destino, 60), producto: trunc(i.producto, 60), vehiculosPorDespachar: i.pendientes, despachable: i.pendientes > 0 })),
        },
      };
    },
    async preparar_despacho(args) {
      await send('⏳ Preparando el despacho en Silogtran… puede tardar unos segundos.');
      // Quick look at the vehicle master first: a plate that does not exist is told at once (and a mis-heard voice note gets caught here).
      // Only a clear «does not exist» stops the turn; any doubt (null) continues with the normal preparation.
      const placa = String(args.placa ?? '').trim().toUpperCase();
      if (placa && (await Promise.resolve(services.checkPlate?.(userId, placa)).catch(() => null)) === false) {
        return { result: { ok: false, preparado: false, code: 'PLATE_NOT_FOUND' }, reply: plateNotFoundText(placa) };
      }
      const r = await services.prepareDispatch(userId, args.numero, args);
      const ext = chooseExternal(r.resumen, args, userText);
      if (ext.reply) return { result: ext.ask, reply: ext.reply }; // fixed text built by code (includes the maximum)
      if (ext.ask) return { result: ext.ask }; // nothing pending: the model asks the person and calls again
      if (ext.eleccion) r.resumen.eleccion = ext.eleccion;
      // The token goes to the pending row; the model only learns that it was prepared.
      const id = await services.createPending(userId, { numero: String(args.numero), token: r.token, resumen: r.resumen, anticipo: r.resumen.anticipoSugerido });
      return { result: { ok: true, preparado: true, ...(ext.note ? { nota: ext.note } : {}) }, pending: { id, resumen: r.resumen, numero: String(args.numero) } };
    },
  };
}

// Tool error -> object the model can read (or a FixedReply that ends the turn).
export function toolError(e) {
  if (e instanceof ApiError) return { fixed: FIXED_REPLIES[e.code] ?? null, result: { ok: false, code: e.code, message: trunc(e.message, 300) } };
  console.error('[ai] tool failed:', e?.code || e?.name || 'error');
  return { fixed: null, result: { ok: false, code: 'TOOL_FAILED', message: 'No se pudo completar la operación.' } };
}
