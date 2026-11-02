// GET /api/health — validates config, Supabase session store, AWS WAF and Silogtran login.
import { requireApiKey } from '../src/http/auth.js';
import { sendError } from '../src/http/errors.js';
import { requireConfig } from '../src/config.js';
import { openSession } from '../src/silogtran/session.js';

export default async function handler(req, res) {
  const started = Date.now();
  try {
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET');
      return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' });
    }
    requireApiKey(req);
    requireConfig();
    const { client, reused } = await openSession();
    res.status(200).json({
      ok: true,
      silogtran: {
        reachable: true,
        loggedIn: true,
        sessionReused: reused,
        wafSolved: client.wafSolved,
        costCenter: client.costCenter,
      },
      supabase: { ok: true },
      elapsedMs: Date.now() - started,
    });
  } catch (e) {
    sendError(res, e);
  }
}
