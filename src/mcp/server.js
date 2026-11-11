// Minimal MCP server over Streamable HTTP, stateless (JSON responses, no sessions, no SSE): initialize, ping, tools/list, tools/call.
import { TOOLS, callTool } from './tools.js';
import { ApiError } from '../http/errors.js';

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INFO = { name: 'silogtran-activaciones', version: '1.0.0' };

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

// One JSON-RPC message -> response object, or null for notifications.
export async function handleMessage(msg, deps) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(msg?.id, -32600, 'Solicitud JSON-RPC inválida.');
  const isNotification = msg.id === undefined || msg.id === null;
  switch (msg.method) {
    case 'initialize': {
      const wanted = msg.params?.protocolVersion;
      return ok(msg.id, {
        protocolVersion: VERSIONS.includes(wanted) ? wanted : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: INFO,
        instructions: 'Activa vehículos en Silogtran por placa. Consulta primero el estado y confirma con la persona antes de activar.',
      });
    }
    case 'ping': return ok(msg.id, {});
    case 'tools/list': return ok(msg.id, { tools: TOOLS });
    case 'tools/call': {
      try {
        const result = await callTool(msg.params?.name, msg.params?.arguments ?? {}, deps);
        return ok(msg.id, result);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'UNKNOWN_TOOL') return err(msg.id, -32602, e.message);
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
export async function handleBody(body, deps) {
  const messages = Array.isArray(body) ? body : [body];
  if (!messages.length || messages.length > 20) return { status: 400, body: err(null, -32600, 'Lote inválido.') };
  const out = (await Promise.all(messages.map((m) => handleMessage(m, deps)))).filter(Boolean);
  if (!out.length) return { status: 202, body: null };
  return { status: 200, body: Array.isArray(body) ? out : out[0] };
}
