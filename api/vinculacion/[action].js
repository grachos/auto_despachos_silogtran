// One function for /api/vinculacion/codigo and /api/vinculacion/estado (see the 12-function limit note in admin/[action].js).
import codigo from '../../src/routes/vinculacion/codigo.js';
import estado from '../../src/routes/vinculacion/estado.js';

const routes = { codigo, estado };

export default function handler(req, res) {
  const fn = Object.hasOwn(routes, req.query?.action) ? routes[req.query.action] : null;
  if (!fn) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'Ruta no encontrada.' });
  return fn(req, res);
}
