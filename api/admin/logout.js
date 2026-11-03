// POST /api/admin/logout — clears the admin cookie.
import { clearAdminCookie } from '../../src/http/admin.js';

export default function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  clearAdminCookie(res);
  res.status(200).json({ ok: true });
}
