// Read-only tools of the DISPATCH MCP (scope `despachar`). They run with the Silogtran session of the person who connected (principal.uid),
// reusing the same services as the WhatsApp assistant. Handlers return { text, structured } or throw ApiError; tools.js wraps them.
// Nothing here writes to Silogtran: preparing/confirming a dispatch comes in later increments.
import { ApiError } from '../http/errors.js';
import { cleanFilters, filterList, buildListText } from '../silogtran/lista.js';
import { consultSolicitud, listSolicitudes, checkPlate } from '../dispatch/service.js';

const OPT = (description) => ({ type: 'string', description, maxLength: 80 });
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
];

// Markdown for chat clients (the list builder was written for WhatsApp: *bold*).
const toMarkdown = (t) => t.replace(/\*([^*\n]+)\*/g, '**$1**');

export const dispatchServices = { listSolicitudes, consultSolicitud, checkPlate };

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
