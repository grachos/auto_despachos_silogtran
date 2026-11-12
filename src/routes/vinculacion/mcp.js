// Person-side MCP access (session cookie of the purpose: `sid_activar` or `sid_despachar`): enable status, one-time ticket, own connections, revoke.
//   POST /api/vinculacion/mcp-ticket { scope? }   GET /api/vinculacion/mcp-conexiones   POST /api/vinculacion/mcp-revocar { id }
import { sendError, ApiError } from '../../http/errors.js';
import { requireEnv } from '../../config.js';
import { requireSession } from '../../http/session.js';
import { SCOPES, CONNECTOR_PATH, TICKET_TTL_MS, getScopes, createTicket, listConnections, revokeConnection } from '../../store/mcp.js';
import { baseUrl } from '../../mcp/auth.js';

const wrap = (method, fn) => async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  try {
    if (req.method !== method) {
      res.setHeader('allow', method);
      return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: `Use ${method}.` });
    }
    requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'TOKEN_SECRET');
    // The purpose comes from the page (?scope= or body.scope); the cookie of THAT purpose is required, so a link for one purpose never opens the other.
    const scope = String(req.query?.scope ?? req.body?.scope ?? 'activar');
    if (!SCOPES.includes(scope)) throw new ApiError('INVALID_PARAMETER', 'Alcance inválido.', { status: 400 });
    const user = await requireSession(req, scope);
    res.status(200).json({ ok: true, ...(await fn(req, user, scope)) });
  } catch (e) {
    sendError(res, e);
  }
};

export const ticket = wrap('POST', async (req, user, scope) => {
  const { ticket: t, expiresAt } = await createTicket(user.id, scope);
  return { ticket: t, scope, expiraEn: expiresAt, segundosDeVigencia: TICKET_TTL_MS / 1000, conectorUrl: `${baseUrl(req)}${CONNECTOR_PATH[scope]}` };
});

export const conexiones = wrap('GET', async (req, user, scope) => {
  const [alcances, activas] = await Promise.all([getScopes(user.id), listConnections(user.id)]);
  return {
    nombre: user.nombre, alcances, conectorUrl: `${baseUrl(req)}${CONNECTOR_PATH[scope]}`,
    conexiones: activas.filter((c) => c.scope === scope).map((c) => ({ id: c.id, alcance: c.scope, etiqueta: c.label, creada: c.created_at, ultimoUso: c.last_used_at })),
  };
});

export const revocar = wrap('POST', async (req, user) => {
  const id = String(req.body?.id ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError('INVALID_PARAMETER', 'Conexión inválida.', { status: 400 });
  return { revocada: await revokeConnection(id, user.id) };
});
