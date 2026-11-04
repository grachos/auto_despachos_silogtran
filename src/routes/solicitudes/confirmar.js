// POST /api/solicitudes/:numero/confirmar { token, anticipo: "total"|"cero", usuario? } — SAVES the dispatch in Silogtran.
// The token is bound to the user that prepared it; `usuario`, if sent, must match.
import { requireApiKey } from '../../http/auth.js';
import { sendError } from '../../http/errors.js';
import { requireConfig } from '../../config.js';
import { assertNumero } from '../../dispatch/service.js';
import { confirmDispatch, parseConfirmar } from '../../confirmar.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
    }
    requireApiKey(req);
    requireConfig();
    const numero = assertNumero(req.query.numero);
    res.status(200).json(await confirmDispatch(numero, parseConfirmar(req.body)));
  } catch (e) {
    sendError(res, e);
  }
}
