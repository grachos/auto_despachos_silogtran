// POST /api/admin/diag-ciudad { numero, usuario? } — READ-ONLY. Shows where Silogtran keeps the municipality (DANE code) of a request's
// origin/destination, to decide «urbano/municipal» by municipality instead of by name (MAN157). See src/silogtran/diagCiudad.js.
import { sendError, ApiError } from '../../http/errors.js';
import { requireConfig } from '../../config.js';
import { requireAdmin } from '../../http/admin.js';
import { withLock } from '../../store/locks.js';
import { assertActorActive, openActorSession, resolveActorId, sessionKey } from '../../silogtran/userSession.js';
import { diagCity } from '../../silogtran/diagCiudad.js';

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  try {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
    }
    requireAdmin(req);
    requireConfig();
    const numero = String(req.body?.numero ?? '').trim();
    if (!/^\d{6,20}$/.test(numero)) throw new ApiError('INVALID_PARAMETER', 'Número de solicitud inválido (solo dígitos).', { status: 400 });
    const userId = await resolveActorId(req.body?.usuario);
    await assertActorActive(userId);
    const out = await withLock(sessionKey(userId), async () => {
      const { client } = await openActorSession(userId);
      return client.enqueue(() => diagCity(client, numero));
    });
    res.status(200).json({ ok: true, ...out });
  } catch (e) {
    sendError(res, e);
  }
}
