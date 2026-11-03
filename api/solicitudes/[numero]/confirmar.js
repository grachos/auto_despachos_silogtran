// POST /api/solicitudes/:numero/confirmar { token, anticipo: "total"|"cero" } — SAVES the dispatch in Silogtran.
import { requireApiKey } from '../../../src/http/auth.js';
import { ApiError, sendError } from '../../../src/http/errors.js';
import { requireConfig } from '../../../src/config.js';
import { confirmDispatch, parseConfirmar } from '../../../src/confirmar.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
    }
    requireApiKey(req);
    requireConfig();
    const numero = String(req.query.numero || '').trim();
    if (!/^\d{4,20}$/.test(numero)) {
      throw new ApiError('INVALID_PARAMETER', 'El número de solicitud debe contener solo dígitos (4 a 20).', { status: 400 });
    }
    res.status(200).json(await confirmDispatch(numero, parseConfirmar(req.body)));
  } catch (e) {
    sendError(res, e);
  }
}
