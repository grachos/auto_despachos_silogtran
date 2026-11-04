// POST /api/solicitudes/:numero/preparar — fills the whole dispatch form without saving and returns a summary plus a
// signed token for `confirmar`. Nothing is saved; the pending item is always cleared.
// Optional `usuario` (user id or Silogtran username, body or query): act as that linked user (service key only).
import { requireApiKey } from '../../http/auth.js';
import { sendError } from '../../http/errors.js';
import { requireConfig } from '../../config.js';
import { resolveActorId } from '../../silogtran/userSession.js';
import { prepareDispatch } from '../../dispatch/service.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
    }
    requireApiKey(req);
    requireConfig();
    const userId = await resolveActorId(req.body?.usuario ?? req.query?.usuario);
    res.status(200).json(await prepareDispatch(userId, req.query.numero, req.body));
  } catch (e) {
    sendError(res, e);
  }
}
