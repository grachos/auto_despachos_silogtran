// Admin side of the MCP access. GET /api/admin/mcp (users + scopes + live connections), POST /api/admin/mcp-permiso { userId, scope, enabled },
// POST /api/admin/mcp-revocar { id }.
import { sendError, ApiError } from '../../http/errors.js';
import { requireEnv } from '../../config.js';
import { requireAdmin } from '../../http/admin.js';
import { supabase } from '../../store/supabase.js';
import { SCOPES, setScope, listAllPermisos, listConnections, revokeConnection } from '../../store/mcp.js';

const wrap = (method, fn) => async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  try {
    if (req.method !== method) {
      res.setHeader('allow', method);
      return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: `Use ${method}.` });
    }
    requireAdmin(req);
    requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_KEY');
    res.status(200).json({ ok: true, ...(await fn(req)) });
  } catch (e) {
    sendError(res, e);
  }
};

export default wrap('GET', async () => {
  const [{ data: users, error }, permisos, conexiones] = await Promise.all([
    supabase().from('app_users').select('id, nombre, silog_user, status').order('nombre'), listAllPermisos(), listConnections(),
  ]);
  if (error) throw new ApiError('STORE_FAILED', 'No se pudo leer los usuarios.', { status: 500, detail: error.message });
  const byUser = new Map(users.map((u) => [u.id, u]));
  return {
    alcances: SCOPES,
    usuarios: users.map((u) => ({ id: u.id, nombre: u.nombre, usuarioSilogtran: u.silog_user, estado: u.status, alcances: permisos.filter((p) => p.user_id === u.id).map((p) => p.scope) })),
    conexiones: conexiones.map((c) => ({ id: c.id, usuario: byUser.get(c.user_id)?.nombre ?? '—', usuarioSilogtran: byUser.get(c.user_id)?.silog_user ?? null, alcance: c.scope, etiqueta: c.label, creada: c.created_at, ultimoUso: c.last_used_at })),
  };
});

export const permiso = wrap('POST', async (req) => {
  const { userId, scope, enabled } = req.body ?? {};
  if (!/^[0-9a-f-]{36}$/i.test(String(userId)) || typeof enabled !== 'boolean') throw new ApiError('INVALID_PARAMETER', 'Faltan userId o enabled.', { status: 400 });
  await setScope(String(userId), String(scope), enabled);
  return { userId, scope, enabled };
});

export const revocar = wrap('POST', async (req) => {
  const id = String(req.body?.id ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError('INVALID_PARAMETER', 'Conexión inválida.', { status: 400 });
  return { revocada: await revokeConnection(id) };
});
