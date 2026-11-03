// POST /api/solicitudes/:numero/preparar and /confirmar share one function (12-function limit on Vercel Hobby).
// GET /api/solicitudes/:numero lives in index.js.
import preparar from '../../../src/routes/solicitudes/preparar.js';
import confirmar from '../../../src/routes/solicitudes/confirmar.js';

const routes = { preparar, confirmar };

export default function handler(req, res) {
  const fn = Object.hasOwn(routes, req.query?.accion) ? routes[req.query.accion] : null;
  if (!fn) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'Ruta no encontrada.' });
  return fn(req, res);
}
