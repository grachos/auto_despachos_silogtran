// POST /api/internal/ministerio { t } — starts (or continues) the background wait for the Ministry's filing number of one manifest.
// Not for people: `t` is a short-lived HMAC token signed by this app (typ "rndc-watch"). Answers 202 at once; the work runs in the
// background of this invocation (waitUntil), with its own 60 s budget.
import { waitUntil } from '@vercel/functions';
import { sendError } from '../../http/errors.js';
import { verifyToken } from '../../token.js';
import { runMinistryWatch } from '../../ministerio/watch.js';

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  try {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
    }
    const p = verifyToken(req.body?.t, 'rndc-watch');
    if (!p.m || !p.p) return res.status(400).json({ ok: false, code: 'INVALID_PARAMETER', message: 'Token incompleto.' });
    const job = runMinistryWatch(p).catch((e) => console.error('[ministerio] watch failed:', e?.code || e?.name || 'error'));
    try { waitUntil(job); } catch { /* not on Vercel (tests/local): the promise just runs */ }
    res.status(202).json({ ok: true });
  } catch (e) {
    sendError(res, e);
  }
}
