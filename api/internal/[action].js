// One serverless function for internal /api/internal/* routes (Vercel Hobby allows at most 12 functions per deployment).
// URLs: /api/internal/ministerio, /api/internal/lote.
import ministerio from '../../src/routes/internal/ministerio.js';
import lote from '../../src/routes/internal/lote.js';

const routes = { ministerio, lote };

export default function handler(req, res) {
  const fn = Object.hasOwn(routes, req.query?.action) ? routes[req.query.action] : null;
  if (!fn) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'Ruta no encontrada.' });
  return fn(req, res);
}
