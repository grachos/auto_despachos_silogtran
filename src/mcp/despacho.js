// Read-only tools of the DISPATCH MCP (scope `despachar`). They run with the Silogtran session of the person who connected (principal.uid),
// reusing the same services as the WhatsApp assistant. Handlers return { text, structured } or throw ApiError; tools.js wraps them.
// Nothing here SAVES in Silogtran: `preparar_despacho` fills the form and leaves a pending summary (confirming comes in the next increment).
import { createHmac } from 'node:crypto';
import { ApiError } from '../http/errors.js';
import { cleanFilters, filterList, buildListText } from '../silogtran/lista.js';
import { consultSolicitud, listSolicitudes, checkPlate, prepareDispatch } from '../dispatch/service.js';
import { createPending } from '../store/ia.js';
import { buildSummaryText } from '../ai/summary.js';
import { chooseExternal } from '../ai/tools.js';

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
];

// Markdown for chat clients (the list builder was written for WhatsApp: *bold*).
const toMarkdown = (t) => t.replace(/\*([^*\n]+)\*/g, '**$1**');

export const dispatchServices = { listSolicitudes, consultSolicitud, checkPlate, prepareDispatch, createPending };

// 4-digit code the person must type to confirm («confirmo 4821»). Derived from the pending id, so nothing extra is stored.
// It forces the summary to be shown, but the model also sees it: a soft barrier, not a hard guarantee (see CLAUDE.md, M6).
export function confirmCode(pendingId) {
  const secret = process.env.TOKEN_SECRET;
  if (!secret) throw new ApiError('CONFIG_MISSING', 'Falta configurar TOKEN_SECRET.', { status: 500 });
  const n = createHmac('sha256', secret).update(`mcp-confirm:${pendingId}`).digest().readUInt32BE(0) % 10000;
  return String(n).padStart(4, '0');
}

const FOOTER = (code) => `Código de confirmación: ${code}\nEste conector todavía NO graba despachos: esto es solo la preparación y no se grabó nada en Silogtran.`;

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
      text: toMarkdown(buildSummaryText(s, { footer: FOOTER(code) })) + `\n\nMuestra este resumen COMPLETO a la persona. Vence en 15 minutos.${interno && s.anticipoSugerido > 0 ? ' El anticipo es interno: la persona debe elegir «total» o «cero».' : ''}`,
      structured: { ok: true, preparado: true, pendienteId: id, venceEnMinutos: 15, numero: String(args.numero), placa: clip(s.vehiculo?.placa, 10), afiliado: s.tipoAfiliado ?? null, anticipoSugerido: s.anticipoSugerido, anticipoElegido: s.eleccion?.anticipo ?? null, requiereElegirAnticipo: interno && s.anticipoSugerido > 0 },
    };
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
