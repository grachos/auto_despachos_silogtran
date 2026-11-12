// Minimal MCP server over Streamable HTTP, stateless (JSON responses, no sessions, no SSE): initialize, ping, tools/list, tools/call.
import { TOOLS, callTool } from './tools.js';
import { ApiError } from '../http/errors.js';

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
// Two servers share this code: activation (scope `activar`, /api/mcp) and dispatch (scope `despachar`, /api/mcp-despacho).
const INFO = { activar: { name: 'silogtran-activaciones', version: '1.1.0' }, despachar: { name: 'silogtran-despacho', version: '0.1.0' } };
const DISPATCH_INSTRUCTIONS = 'Consulta y PREPARA despachos de transporte en Silogtran con el usuario de Silogtran de la persona que conectó este acceso. POR AHORA NO GRABA: preparar_despacho llena el formulario y devuelve el resumen real, pero este conector todavía no puede confirmar ni grabar un despacho. Herramientas: listar_solicitudes (cuando la persona no recuerda el número o pide por cliente, ruta, producto o tipo de vehículo), consultar_solicitud (un número concreto), comprobar_placa (si una placa existe y está activa) y preparar_despacho (con solicitud, placa y las dos citas de cargue y descargue; llámala de inmediato, sin preguntar antes por afiliado, beneficiario ni anticipo). Si el vehículo es externo, la herramienta devuelve la pregunta del anticipo: pásasela a la persona tal cual y vuelve a llamar con su respuesta; nunca supongas ni reutilices un beneficiario o un valor de otro despacho. Muestra SIEMPRE el resumen completo que devuelve preparar_despacho. Nunca inventes números de solicitud ni placas. Para activar placas, trailers o terceros inactivos la persona debe usar el conector de activaciones.';

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

// One JSON-RPC message -> response object, or null for notifications.
export async function handleMessage(msg, deps, principal, srv = 'activar') {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(msg?.id, -32600, 'Solicitud JSON-RPC inválida.');
  const isNotification = msg.id === undefined || msg.id === null;
  switch (msg.method) {
    case 'initialize': {
      const wanted = msg.params?.protocolVersion;
      console.log('[mcp] initialize', String(wanted).slice(0, 20), String(msg.params?.clientInfo?.name ?? '-').replace(/[^\w .-]/g, '').slice(0, 40));
      return ok(msg.id, {
        protocolVersion: VERSIONS.includes(wanted) ? wanted : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: INFO[srv] ?? INFO.activar,
        instructions: srv === 'despachar' ? DISPATCH_INSTRUCTIONS : 'Activa en Silogtran lo que hace falta para despachar una placa: el vehículo, su trailer y los terceros conductor, propietario y poseedor (pueden ser la misma persona o distintas). Cómo actuar: (1) si la persona pide activar TODO de una placa («activa todo», «todos los entes», «la placa y sus entes», «déjala lista para despachar»), llama DE INMEDIATO a activar_vehiculo con entes ["todos"], sin preguntar; (2) si pide algo concreto («activa la placa X», «activa solo el conductor de X», «activa el trailer»), hazlo directamente con ese ente en entes; (3) si solo pide revisar o no está claro qué activar, llama a revisar_vehiculo, muestra el estado de CADA ente con su nombre y pregunta qué activar. Cada ente se puede activar por separado. Nunca actives algo que la persona no pidió. Para un tercero suelto usa consultar_tercero / activar_tercero con su documento.',
      });
    }
    case 'ping': return ok(msg.id, {});
    case 'tools/list': console.log('[mcp] tools/list'); return ok(msg.id, { tools: TOOLS.filter((t) => t.scope === srv && (principal?.kind !== 'user' || t.scope === principal.scope)).map(({ scope, ...t }) => t) });
    case 'tools/call': {
      try {
        // Name and argument KEYS only (never values): shows what the client actually sends.
        console.log('[mcp] call', String(msg.params?.name).replace(/[^\w-]/g, '').slice(0, 40), Object.keys(msg.params?.arguments ?? {}).join(',') || '-');
        const result = await callTool(msg.params?.name, msg.params?.arguments ?? {}, deps, principal);
        return ok(msg.id, result);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'UNKNOWN_TOOL') {
          console.error('[mcp] unknown tool requested:', String(msg.params?.name).replace(/[^\w-]/g, '').slice(0, 40));
          return err(msg.id, -32602, e.message);
        }
        console.error('[mcp] call failed:', e?.code || e?.name || 'error');
        return err(msg.id, -32603, 'Error interno del servidor MCP.');
      }
    }
    default:
      if (isNotification || msg.method.startsWith('notifications/')) return null;
      return err(msg.id, -32601, `Método no soportado: ${msg.method.slice(0, 40)}.`);
  }
}

// Body (object or array) -> { status, body } for the HTTP layer.
export async function handleBody(body, deps, principal, srv = 'activar') {
  const messages = Array.isArray(body) ? body : [body];
  if (!messages.length || messages.length > 20) return { status: 400, body: err(null, -32600, 'Lote inválido.') };
  const out = (await Promise.all(messages.map((m) => handleMessage(m, deps, principal, srv)))).filter(Boolean);
  if (!out.length) return { status: 202, body: null };
  return { status: 200, body: Array.isArray(body) ? out : out[0] };
}
