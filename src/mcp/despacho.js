// Read-only tools of the DISPATCH MCP (scope `despachar`). They run with the Silogtran session of the person who connected (principal.uid),
// reusing the same services as the WhatsApp assistant. Handlers return { text, structured } or throw ApiError; tools.js wraps them.
// `preparar_despacho` never saves; only `confirmar_despacho` does, and only with the pending id + the 4-digit code the person typed.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../http/errors.js';
import { cleanFilters, filterList, buildListText } from '../silogtran/lista.js';
import { consultSolicitud, listSolicitudes, checkPlate, prepareDispatch, manifestStatus } from '../dispatch/service.js';
import { createPending, getPending, claimPending, finishPending, pendingProblem } from '../store/ia.js';
import { confirmDispatch } from '../confirmar.js';
import { buildSummaryText, resultText, EXPLAIN, CONFIRM_ERRORS } from '../ai/summary.js';
import { chooseExternal } from '../ai/tools.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPT = (description) => ({ type: 'string', description, maxLength: 80 });
const CITA = (label) => ({ type: 'object', additionalProperties: false, required: ['fecha', 'hora'], properties: { fecha: { type: 'string', description: `${label}: fecha YYYY-MM-DD` }, hora: { type: 'string', description: `${label}: hora HH:mm (24 h)` } } });
const TIEMPO = (description) => ({ type: 'object', additionalProperties: false, required: ['horas', 'minutos'], properties: { horas: { type: 'integer', minimum: 0, maximum: 99 }, minutos: { type: 'integer', minimum: 0, maximum: 59 } }, description });
const clip = (v, n = 60) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export const DISPATCH_TOOLS = [
  {
    name: 'listar_solicitudes',
    description: 'Lista las solicitudes de transporte de Silogtran que AÚN tienen cupos libres (las completas, como 2/2, no salen). Úsala cuando la persona no recuerda el número, da un número incompleto o pide ver solicitudes por criterio (cliente, ruta, producto, usuario que la creó, tipo de vehículo). Todos los filtros son opcionales. Muestra primero las solicitudes de la propia persona. Solo lectura.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        numero: OPT('Número de solicitud o sus últimos dígitos (ej. «3220»).'),
        usuario: OPT('Usuario de Silogtran que creó la solicitud (ej. AECHEVERRI).'),
        origen: OPT('Ciudad de origen.'),
        destino: OPT('Ciudad de destino.'),
        cliente: OPT('Nombre o parte del nombre del cliente.'),
        producto: OPT('Producto (ej. «aceite de palma»).'),
        vehiculo: OPT('Tipo de vehículo o carrocería (ej. «tractomula», «tanque»).'),
      },
    },
    annotations: { title: 'Listar solicitudes con cupos', readOnlyHint: true, openWorldHint: true },
    scope: 'despachar',
  },
  {
    name: 'consultar_solicitud',
    description: 'Consulta UNA solicitud de transporte por su número completo: origen, destino y producto de cada ítem, cuántos vehículos quedan por despachar y si requiere contenedor. Solo lectura.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['numero'], properties: { numero: { type: 'string', description: 'Número de la solicitud, solo dígitos (4 a 20).', minLength: 4, maxLength: 20 } } },
    annotations: { title: 'Consultar una solicitud', readOnlyHint: true, openWorldHint: true },
    scope: 'despachar',
  },
  {
    name: 'comprobar_placa',
    description: 'Comprueba si una placa existe en el maestro de vehículos de Silogtran y si está ACTIVA o INACTIVA, antes de intentar despachar con ella. Solo lectura. Si está inactiva, activarla es tarea del conector de activaciones.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['placa'], properties: { placa: { type: 'string', description: 'Placa del vehículo, letras y números sin espacios (ej. «ABC123»).', minLength: 4, maxLength: 10 } } },
    annotations: { title: 'Comprobar una placa', readOnlyHint: true, openWorldHint: true },
    scope: 'despachar',
  },
  {
    name: 'preparar_despacho',
    description: 'Prepara un despacho en Silogtran SIN grabarlo y devuelve el RESUMEN real (placa, conductor, ruta, citas, anticipo) con un código de confirmación. Úsala en cuanto tengas solicitud, placa y las dos citas (cargue y descargue); no preguntes nada más por adelantado. Si el vehículo es externo y falta beneficiario o valor del anticipo, devuelve la pregunta para la persona: pásala tal cual y vuelve a llamar con lo que responda (nunca lo supongas ni lo reutilices de otro despacho). Muestra SIEMPRE el resumen completo a la persona. Las citas son fecha YYYY-MM-DD y hora HH:mm en formato 24 h (hora de Bogotá). Los demás campos solo si la persona los dijo.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['numero', 'placa', 'citaCargue', 'citaDescargue'],
      properties: {
        numero: { type: 'string', description: 'Número de la solicitud, solo dígitos.', minLength: 4, maxLength: 20 },
        item: { type: 'integer', description: 'Ítem de la solicitud; omítelo si solo hay uno.' },
        placa: { type: 'string', description: 'Placa del vehículo (letras y números).', minLength: 4, maxLength: 10 },
        citaCargue: CITA('Cita de cargue'),
        citaDescargue: CITA('Cita de descargue'),
        fuente: { type: 'string', enum: ['activos', 'empresas'], description: '«empresas» solo si la persona dijo «viaje empresa» o «por empresa»; si no, omítelo (Vehículos Activos).' },
        tipoManifiesto: OPT('Tipo de manifiesto (código o nombre); omítelo para el valor por defecto.'),
        tipoOperacion: OPT('Solo si la persona lo pidió expresamente (ej. «líquida», «carga seca»).'),
        tiempoCargue: TIEMPO('Tiempo pactado de cargue (por defecto 2 h 0 min; no lo preguntes).'),
        tiempoDescargue: TIEMPO('Tiempo pactado de descargue (por defecto 2 h 0 min; no lo preguntes).'),
        ordenCompra: OPT('Orden de compra, si la dieron.'),
        observacionOrdenCargue: OPT('Observación de la orden de cargue, si la dieron.'),
        observacionRemesa: OPT('Observación de la remesa, si la dieron.'),
        contenedor: OPT('Número de contenedor, si aplica.'),
        bl: OPT('Número de BL, si aplica.'),
        beneficiario: { type: 'string', enum: ['conductor', 'poseedor'], description: 'Solo vehículos externos y SOLO si la persona lo dijo: a quién va el anticipo.' },
        anticipo: { type: 'integer', minimum: 0, description: 'Solo vehículos externos y SOLO si la persona lo dijo: valor del anticipo en pesos (0 si no habrá).' },
      },
    },
    annotations: { title: 'Preparar un despacho (no graba)', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    scope: 'despachar',
  },
  {
    name: 'confirmar_despacho',
    description: 'GRABA en Silogtran el despacho que preparó preparar_despacho (genera orden de cargue, remesa, manifiesto y, si hay anticipo, la transferencia: mueve dinero). SOLO puedes llamarla después de mostrarle a la persona el resumen COMPLETO y de que ELLA escriba en el chat «confirmo» seguido del código de 4 dígitos del resumen (ej. «confirmo 4821»). Nunca la llames por tu cuenta, ni con un código que la persona no haya escrito, ni porque dijo «sí» sin el código. `anticipo`: vehículo interno → «total» o «cero» según lo que la persona elija; vehículo externo → el mismo valor en pesos que muestra el resumen. Un despacho se confirma una sola vez.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['pendienteId', 'codigo', 'anticipo'],
      properties: {
        pendienteId: { type: 'string', description: 'El pendienteId que devolvió preparar_despacho.', minLength: 36, maxLength: 36 },
        codigo: { type: 'string', description: 'Código de 4 dígitos que la persona escribió («confirmo 4821» → «4821»).', minLength: 4, maxLength: 4 },
        anticipo: { type: ['string', 'integer'], description: 'Interno: «total» o «cero». Externo: el valor en pesos del resumen (entero; 0 si no hay anticipo).' },
      },
    },
    annotations: { title: 'Confirmar y grabar el despacho', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    scope: 'despachar',
  },
  {
    name: 'estado_despacho',
    description: 'Consulta el estado en el Ministerio (RNDC) de un manifiesto ya generado: si tiene radicado o todavía no. El Ministerio puede tardar 30 a 60 segundos en dar el radicado; los viajes cargados por la pestaña Empresas no se reportan al Ministerio. Solo lectura.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['manifiesto'], properties: { manifiesto: { type: 'string', description: 'Número de manifiesto, solo dígitos.', minLength: 3, maxLength: 20 } } },
    annotations: { title: 'Estado del manifiesto en el Ministerio', readOnlyHint: true, openWorldHint: true },
    scope: 'despachar',
  },
];

// Markdown for chat clients (the list builder was written for WhatsApp: *bold*).
const toMarkdown = (t) => t.replace(/\*([^*\n]+)\*/g, '**$1**');

export const dispatchServices = { listSolicitudes, consultSolicitud, checkPlate, prepareDispatch, createPending, getPending, claimPending, finishPending, confirmDispatch, manifestStatus };

// 4-digit code the person must type to confirm («confirmo 4821»). Derived from the pending id, so nothing extra is stored.
// It forces the summary to be shown, but the model also sees it: a soft barrier, not a hard guarantee (see CLAUDE.md, M6).
export function confirmCode(pendingId) {
  const secret = process.env.TOKEN_SECRET;
  if (!secret) throw new ApiError('CONFIG_MISSING', 'Falta configurar TOKEN_SECRET.', { status: 500 });
  const n = createHmac('sha256', secret).update(`mcp-confirm:${pendingId}`).digest().readUInt32BE(0) % 10000;
  return String(n).padStart(4, '0');
}

const FOOTER = (code) => `Código de confirmación: ${code}\nTodavía NO se grabó nada en Silogtran. Para grabar, la persona debe escribir «confirmo ${code}» (y elegir el anticipo si es un vehículo interno).`;

export const DISPATCH_HANDLERS = {
  async listar_solicitudes(args, principal, services = dispatchServices) {
    const f = cleanFilters(args);
    const { rows, miUsuario } = await services.listSolicitudes(principal.uid);
    const matches = filterList(rows, f, miUsuario);
    const shown = matches.slice(0, 10).map((r) => ({
      numero: r.numero, item: r.item, cupos: r.cupos, total: r.total, fechaCargue: clip(r.fechaCargue, 20), cliente: clip(r.cliente), origen: clip(r.origen), destino: clip(r.destino),
      producto: clip(r.producto), vehiculo: clip(r.vehiculo), tipoFlete: clip(r.tipoFlete, 30), usuario: clip(r.usuario, 30),
    }));
    return { text: toMarkdown(buildListText(matches, f, miUsuario)), structured: { ok: true, coincidencias: matches.length, mostradas: shown.length, solicitudes: shown } };
  },

  async consultar_solicitud(args, principal, services = dispatchServices) {
    const s = await services.consultSolicitud(principal.uid, args.numero);
    const items = s.items.map((i) => ({ item: i.item, origen: clip(i.origen), destino: clip(i.destino), producto: clip(i.producto), porDespachar: i.pendientes, despachable: i.pendientes > 0 }));
    const open = items.filter((i) => i.despachable);
    const lines = [`Solicitud ${s.numero}${s.requiereContenedor ? ' (requiere contenedor)' : ''}:`];
    for (const i of items) lines.push(`• Ítem ${i.item}: ${i.origen} → ${i.destino} · ${i.producto} — ${i.porDespachar > 0 ? `quedan ${i.porDespachar} vehículo(s) por despachar` : 'sin cupos (completa)'}`);
    if (!open.length) lines.push('Esta solicitud está AGOTADA: no tiene vehículos por despachar.');
    return { text: lines.join('\n'), structured: { ok: true, numero: String(s.numero), requiereContenedor: !!s.requiereContenedor, despachable: open.length > 0, items } };
  },

  async preparar_despacho(args, principal, services = dispatchServices) {
    const placa = String(args.placa ?? '').trim().toUpperCase();
    // Quick plate check first (fixed answers; any doubt continues with the normal preparation).
    const plate = placa ? await Promise.resolve(services.checkPlate?.(principal.uid, placa)).catch(() => null) : null;
    if (plate === 'missing') throw new ApiError('PLATE_NOT_FOUND', `No encontré la placa ${placa.replace(/[^A-Z0-9]/g, '')} en Silogtran. Revisa que esté bien escrita.`, { status: 404 });
    if (plate === 'inactive') throw new ApiError('PLATE_INACTIVE', `La placa ${placa.replace(/[^A-Z0-9]/g, '')} está INACTIVA en Silogtran. Actívala con el conector de activaciones y vuelve a intentar.`, { status: 409 });
    const r = await services.prepareDispatch(principal.uid, args.numero, args);
    const ext = chooseExternal(r.resumen, args); // external vehicle: who gets the advance and how much are never assumed
    if (ext.reply) return { text: toMarkdown(ext.reply), structured: { ...ext.ask, ok: ext.ask.ok } };
    if (ext.ask) return { text: 'Falta información del anticipo.', structured: ext.ask };
    if (ext.eleccion) r.resumen.eleccion = ext.eleccion;
    r.resumen.origen = 'mcp'; // marks it so the WhatsApp «sí» never resends buttons for it
    const id = await services.createPending(principal.uid, { numero: String(args.numero), token: r.token, resumen: r.resumen, anticipo: r.resumen.anticipoSugerido });
    const code = confirmCode(id);
    const s = r.resumen;
    const interno = s.tipoAfiliado !== 'EXTERNO';
    return {
      text: toMarkdown(buildSummaryText(s, { footer: FOOTER(code) })) + `\n\nMuestra este resumen COMPLETO a la persona y pídele que escriba «confirmo» y el código para grabar. Vence en 15 minutos.${interno && s.anticipoSugerido > 0 ? ' El anticipo es interno: la persona debe elegir «total» o «cero».' : ''}`,
      structured: { ok: true, preparado: true, pendienteId: id, venceEnMinutos: 15, numero: String(args.numero), placa: clip(s.vehiculo?.placa, 10), afiliado: s.tipoAfiliado ?? null, anticipoSugerido: s.anticipoSugerido, anticipoElegido: s.eleccion?.anticipo ?? null, requiereElegirAnticipo: interno && s.anticipoSugerido > 0 },
    };
  },

  async confirmar_despacho(args, principal, services = dispatchServices) {
    const uid = principal.uid;
    const id = String(args.pendienteId ?? '').trim().toLowerCase();
    if (!UUID.test(id)) throw new ApiError('INVALID_PARAMETER', 'El pendienteId no es válido: usa el que devolvió preparar_despacho.', { status: 400 });
    const code = String(args.codigo ?? '').trim();
    if (!/^\d{4}$/.test(code)) throw new ApiError('CONFIRM_CODE_REQUIRED', 'Falta el código de confirmación de 4 dígitos. La persona debe escribir «confirmo» y el código que trae el resumen.', { status: 400 });
    // Everything below is checked BEFORE claiming, so a wrong request leaves the pending summary untouched.
    const row0 = await services.getPending(id);
    const why = pendingProblem(row0, uid);
    if (why) throw new ApiError(`PENDING_${why}`, EXPLAIN[why] ?? EXPLAIN.NOT_FOUND, { status: 409 });
    if (row0.resumen?.origen !== 'mcp') throw new ApiError('PENDING_NOT_FOUND', EXPLAIN.NOT_FOUND, { status: 404 });
    const want = Buffer.from(confirmCode(id)), got = Buffer.from(code);
    if (!timingSafeEqual(want, got)) throw new ApiError('CONFIRM_CODE_INVALID', 'El código no coincide con el del resumen. No se grabó nada. Pídele a la persona que lo escriba tal cual aparece en el resumen.', { status: 403 });
    const external = row0.resumen?.tipoAfiliado === 'EXTERNO';
    const el = row0.resumen?.eleccion;
    let confirmArgs;
    if (external) {
      if (!el?.beneficiario?.id) throw new ApiError('BENEFICIARY_REQUIRED', 'Este resumen no tiene beneficiario y valor del anticipo. Vuelve a llamar a preparar_despacho.', { status: 409 });
      const asked = typeof args.anticipo === 'number' ? args.anticipo : Number(String(args.anticipo ?? '').replace(/[^\d]/g, ''));
      if (!Number.isSafeInteger(asked) || asked !== el.anticipo) throw new ApiError('ANTICIPO_MISMATCH', `El anticipo del resumen es $${Number(el.anticipo).toLocaleString('es-CO')}; indica ese mismo valor (en pesos) para confirmar. No se grabó nada.`, { status: 409 });
      confirmArgs = { anticipo: el.anticipo, beneficiario: el.beneficiario.id };
    } else {
      const mode = String(args.anticipo ?? '').trim().toLowerCase();
      if (mode !== 'total' && mode !== 'cero') throw new ApiError('ANTICIPO_REQUIRED', 'Falta elegir el anticipo: «total» o «cero». Pregúntaselo a la persona. No se grabó nada.', { status: 400 });
      confirmArgs = { anticipo: mode };
    }
    const row = await services.claimPending(id, uid); // atomic: only one confirmation can win
    if (!row) throw new ApiError('PENDING_UNAVAILABLE', 'Ese resumen ya no está disponible (otra confirmación lo tomó, venció o fue reemplazado).', { status: 409 });
    try {
      const r = await services.confirmDispatch(row.numero, { token: row.token, ...confirmArgs, origen: 'mcp' });
      await services.finishPending(id, 'USED');
      const t = resultText(r, row.resumen).replace(/Ministerio: verificando el radicado[^\n]*/, 'Ministerio: aún sin radicado; consulta estado_despacho en un momento (puede tardar 30 a 60 s).');
      return { text: t, structured: { ok: true, status: r.status ?? 'DISPATCHED', repetido: Boolean(r.repeated), documentos: r.documents ?? {}, ministerio: r.ministerio ?? null, radicado: r.rndc?.radicado ?? null, advertencias: (r.warnings ?? []).slice(0, 5) } };
    } catch (e) {
      const map = CONFIRM_ERRORS[e?.code];
      await services.finishPending(id, map?.final ?? 'PENDING').catch(() => {});
      if (map && e instanceof ApiError) throw new ApiError(e.code, `${map.text} No sigas reintentando solo.`, { status: e.status ?? 409 });
      throw e;
    }
  },

  async estado_despacho(args, principal, services = dispatchServices) {
    const m = String(args.manifiesto ?? '').trim();
    const st = await services.manifestStatus(principal.uid, m);
    const base = { ok: true, manifiesto: m };
    if (st?.migrated) return { text: `Manifiesto ${m}: el Ministerio ya dio el radicado ${st.radicado}${st.fechaHora ? ` (${st.fechaHora})` : ''}. Subió sin inconvenientes.`, structured: { ...base, radicado: st.radicado, fechaHora: st.fechaHora ?? null, migrado: true } };
    return { text: `Manifiesto ${m}: todavía SIN radicado del Ministerio. Puede tardar 30 a 60 segundos después de grabar; si pasan varios minutos, revisa las causas en Silogtran. (Los viajes cargados por la pestaña Empresas no se reportan al Ministerio.)`, structured: { ...base, radicado: null, migrado: false } };
  },

  async comprobar_placa(args, principal, services = dispatchServices) {
    const placa = String(args.placa ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,10}$/.test(placa)) throw new ApiError('INVALID_PARAMETER', 'La placa debe tener entre 4 y 10 letras o números, sin espacios ni símbolos.', { status: 400 });
    const st = await services.checkPlate(principal.uid, placa);
    const say = {
      ok: `La placa ${placa} existe en Silogtran y está ACTIVA.`,
      inactive: `La placa ${placa} existe pero está INACTIVA, así que no se puede despachar con ella. Para activarla (y sus terceros o trailer) usa el conector de activaciones.`,
      missing: `No encontré la placa ${placa} en el maestro de vehículos de Silogtran. Revisa que esté bien escrita; si es la placa de un trailer, no se consulta aquí.`,
    }[st] ?? `No pude comprobar la placa ${placa} en este momento (Silogtran no respondió con claridad). Intenta de nuevo en un momento.`;
    return { text: say, structured: { ok: true, placa, estado: st === 'ok' ? 'ACTIVA' : st === 'inactive' ? 'INACTIVA' : st === 'missing' ? 'NO_EXISTE' : 'DESCONOCIDO' } };
  },
};
