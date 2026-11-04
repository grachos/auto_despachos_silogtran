// The ONLY tools the model has. There is deliberately no tool to confirm/save a dispatch.
import { ApiError } from '../http/errors.js';
import { consultSolicitud, prepareDispatch } from '../dispatch/service.js';
import { createPending } from '../store/ia.js';

const str = (description) => ({ type: 'string', description });
const optStr = (description) => ({ type: ['string', 'null'], description });
const cita = (label) => ({
  type: 'object', additionalProperties: false, required: ['fecha', 'hora'],
  properties: { fecha: str(`${label}: fecha YYYY-MM-DD`), hora: str(`${label}: hora HH:mm en formato 24 h`) },
});

export const TOOLS = [
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
      description: 'Prepara un despacho en Silogtran SIN grabarlo. Si sale bien, el sistema mostrará el resumen con botones para que la persona confirme. Úsala solo cuando tengas todos los datos obligatorios.',
      strict: true,
      parameters: {
        type: 'object', additionalProperties: false,
        required: ['numero', 'item', 'placa', 'citaCargue', 'citaDescargue', 'tipoManifiesto', 'ordenCompra', 'observacionOrdenCargue', 'observacionRemesa', 'contenedor', 'bl'],
        properties: {
          numero: str('Número de la solicitud, solo dígitos'),
          item: { type: ['integer', 'null'], description: 'Ítem de la solicitud; null si solo hay uno' },
          placa: str('Placa del vehículo'),
          citaCargue: cita('Cita de cargue'),
          citaDescargue: cita('Cita de descargue'),
          tipoManifiesto: optStr('Tipo de manifiesto (código o nombre); null para usar el valor por defecto'),
          ordenCompra: optStr('Orden de compra; null si no la dieron'),
          observacionOrdenCargue: optStr('Observación de la orden de cargue; null si no la dieron'),
          observacionRemesa: optStr('Observación de la remesa; null si no la dieron'),
          contenedor: optStr('Número de contenedor; null si no aplica'),
          bl: optStr('Número de BL; null si no aplica'),
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

// Executors bound to the actor (the person linked to this phone). The actor is never a model-controlled argument.
export function makeExecutors({ userId, send, services = { consultSolicitud, prepareDispatch, createPending } }) {
  return {
    async consultar_solicitud(args) {
      const s = await services.consultSolicitud(userId, args.numero);
      return {
        result: {
          ok: true, numero: s.numero, requiereContenedor: s.requiereContenedor,
          items: s.items.map((i) => ({ item: i.item, origen: trunc(i.origen, 60), destino: trunc(i.destino, 60), producto: trunc(i.producto, 60), vehiculosPendientes: i.pendientes })),
        },
      };
    },
    async preparar_despacho(args) {
      await send('⏳ Preparando el despacho en Silogtran… puede tardar unos segundos.');
      const r = await services.prepareDispatch(userId, args.numero, args);
      // The token goes to the pending row; the model only learns that it was prepared.
      const id = await services.createPending(userId, { numero: String(args.numero), token: r.token, resumen: r.resumen, anticipo: r.resumen.anticipoSugerido });
      return { result: { ok: true, preparado: true }, pending: { id, resumen: r.resumen, numero: String(args.numero) } };
    },
  };
}

// Tool error -> object the model can read (or a FixedReply that ends the turn).
export function toolError(e) {
  if (e instanceof ApiError) return { fixed: FIXED_REPLIES[e.code] ?? null, result: { ok: false, code: e.code, message: trunc(e.message, 300) } };
  console.error('[ai] tool failed:', e?.code || e?.name || 'error');
  return { fixed: null, result: { ok: false, code: 'TOOL_FAILED', message: 'No se pudo completar la operación.' } };
}
