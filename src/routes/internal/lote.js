// POST /api/internal/lote { t } — prepares ONE row of a batch (M7.2) and chains to the next. Not for people: `t` is a short-lived HMAC token
// signed by this app (typ "lote-step"). Answers 202 at once; the work runs in the background of this invocation (waitUntil, own 60 s).
import { waitUntil } from '@vercel/functions';
import { sendError } from '../../http/errors.js';
import { verifyToken } from '../../token.js';
import { runLoteStep } from '../../lote/worker.js';

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  try {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
    }
    const p = verifyToken(req.body?.t, 'lote-step');
    if (!p.l || !Number.isInteger(p.n)) return res.status(400).json({ ok: false, code: 'INVALID_PARAMETER', message: 'Token incompleto.' });
    const job = runLoteStep(p).catch((e) => console.error('[lote] step failed:', e?.code || e?.name || 'error'));
    try { waitUntil(job); } catch { /* not on Vercel (tests/local): the promise just runs */ }
    res.status(202).json({ ok: true });
  } catch (e) {
    sendError(res, e);
  }
}
