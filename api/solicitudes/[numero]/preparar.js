// POST /api/solicitudes/:numero/preparar — fills the whole dispatch form without saving and returns a
// summary plus a signed token for `confirmar`. Nothing is saved; the pending item is always cleared.
import { randomUUID } from 'node:crypto';
import { requireApiKey } from '../../../src/http/auth.js';
import { ApiError, sendError } from '../../../src/http/errors.js';
import { requireConfig } from '../../../src/config.js';
import { parsePreparar } from '../../../src/validation.js';
import { assertTokenSecret, signToken } from '../../../src/token.js';
import { openSession } from '../../../src/silogtran/session.js';
import { runPreparation } from '../../../src/silogtran/preparar.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
    }
    requireApiKey(req);
    requireConfig();
    assertTokenSecret(); // fail before touching Silogtran
    const numero = String(req.query.numero || '').trim();
    if (!/^\d{4,20}$/.test(numero)) {
      throw new ApiError('INVALID_PARAMETER', 'El número de solicitud debe contener solo dígitos (4 a 20).', { status: 400 });
    }
    const input = parsePreparar(req.body);
    const { client } = await openSession();
    const { summary, item } = await runPreparation(client, numero, input);
    const token = signToken({ jti: randomUUID(), numero, item, input, anticipo: summary.anticipoSugerido });
    res.status(200).json({ ok: true, resumen: summary, token, tokenExpiraEnSegundos: 900 });
  } catch (e) {
    sendError(res, e);
  }
}
