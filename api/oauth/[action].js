// One function for the OAuth endpoints of the MCP (Vercel Hobby: max 12 functions). /.well-known/* paths are rewritten here (vercel.json).
import { metadata, resource, register, authorize, token } from '../../src/routes/oauth.js';

const routes = { metadata, resource, register, authorize, token };

export default function handler(req, res) {
  const fn = Object.hasOwn(routes, req.query?.action) ? routes[req.query.action] : null;
  if (!fn) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'Ruta no encontrada.' });
  return fn(req, res);
}
