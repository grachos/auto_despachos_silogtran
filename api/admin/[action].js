// One serverless function for all /api/admin/* routes (Vercel Hobby allows at most 12 functions per deployment).
// URLs are unchanged: /api/admin/login, /logout, /usuarios, /reporte, /rndc-actualizar, /invitaciones.
import login from '../../src/routes/admin/login.js';
import logout from '../../src/routes/admin/logout.js';
import usuarios from '../../src/routes/admin/usuarios.js';
import reporte from '../../src/routes/admin/reporte.js';
import rndc from '../../src/routes/admin/rndc-actualizar.js';
import invitaciones from '../../src/routes/admin/invitaciones.js';
import diagVehiculo from '../../src/routes/admin/diag-vehiculo.js';
import diagManifiesto from '../../src/routes/admin/diag-manifiesto.js';
import diagSolicitudes from '../../src/routes/admin/diag-solicitudes.js';
import diagPlaca from '../../src/routes/admin/diag-placa.js';
import diagActivar from '../../src/routes/admin/diag-activar.js';

const routes = { login, logout, usuarios, reporte, 'rndc-actualizar': rndc, invitaciones, 'diag-vehiculo': diagVehiculo, 'diag-manifiesto': diagManifiesto, 'diag-solicitudes': diagSolicitudes, 'diag-placa': diagPlaca, 'diag-activar': diagActivar };

export default function handler(req, res) {
  const fn = Object.hasOwn(routes, req.query?.action) ? routes[req.query.action] : null;
  if (!fn) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'Ruta no encontrada.' });
  return fn(req, res);
}
