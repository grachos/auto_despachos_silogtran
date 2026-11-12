// Minimal MCP server over Streamable HTTP, stateless (JSON responses, no sessions, no SSE): initialize, ping, tools/list, tools/call.
import { TOOLS, callTool } from './tools.js';
import { ApiError } from '../http/errors.js';

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INFO = { name: 'silogtran-activaciones', version: '1.1.0' };

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

// One JSON-RPC message -> response object, or null for notifications.
export async function handleMessage(msg, deps, principal) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(msg?.id, -32600, 'Solicitud JSON-RPC inválida.');
  const isNotification = msg.id === undefined || msg.id === null;
  switch (msg.method) {
    case 'initialize': {
      const wanted = msg.params?.protocolVersion;
      return ok(msg.id, {
        protocolVersion: VERSIONS.includes(wanted) ? wanted : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: INFO,
        instructions: 'Activa en Silogtran lo que hace falta para despachar una placa: el vehículo, su trailer y los terceros conductor, propietario y poseedor (pueden ser la misma persona o distintas). Cómo actuar: (1) si la persona pide activar TODO de una placa («activa todo», «todos los entes», «la placa y sus entes», «déjala lista para despachar»), llama DE INMEDIATO a activar_vehiculo con entes ["todos"], sin preguntar; (2) si pide algo concreto («activa la placa X», «activa solo el conductor de X», «activa el trailer»), hazlo directamente con ese ente en entes; (3) si solo pide revisar o no está claro qué activar, llama a revisar_vehiculo, muestra el estado de CADA ente con su nombre y pregunta qué activar. Cada ente se puede activar por separado. Nunca actives algo que la persona no pidió. Para un tercero suelto usa consultar_tercero / activar_tercero con su documento.',
      });
    }
    case 'ping': return ok(msg.id, {});
    case 'tools/list': return ok(msg.id, { tools: TOOLS.filter((t) => principal?.kind !== 'user' || t.scope === principal.scope).map(({ scope, ...t }) => t) });
    case 'tools/call': {
      try {
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
export async function handleBody(body, deps, principal) {
  const messages = Array.isArray(body) ? body : [body];
  if (!messages.length || messages.length > 20) return { status: 400, body: err(null, -32600, 'Lote inválido.') };
  const out = (await Promise.all(messages.map((m) => handleMessage(m, deps, principal)))).filter(Boolean);
  if (!out.length) return { status: 202, body: null };
  return { status: 200, body: Array.isArray(body) ? out : out[0] };
}
