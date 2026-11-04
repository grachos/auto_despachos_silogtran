// POST /api/admin/rndc-actualizar — re-reads the Ministry (RNDC) status of recent manifests that have no filing
// number yet (up to 10 per call) and stores radicado / date-time.
import { sendError } from '../../http/errors.js';
import { requireEnv, requireConfig } from '../../config.js';
import { requireAdmin } from '../../http/admin.js';
import { pendingRndc, saveRndc } from '../../store/admin.js';
import { openSession } from '../../silogtran/session.js';
import { withLock } from '../../store/locks.js';
import { readRndc } from '../../silogtran/grabar.js';

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  try {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
    }
    requireAdmin(req);
    requireConfig(); // reads Silogtran with the user-zero session
    requireEnv('TOKEN_SECRET');
    const pend = await pendingRndc(10);
    if (!pend.length) return res.status(200).json({ ok: true, revisados: 0, nuevosRadicados: 0, mensaje: 'No hay manifiestos pendientes de radicado.' });
    // Uses the user-zero Silogtran session: take its lock so it never overlaps with a user-zero dispatch.
    const { nuevos, errores } = await withLock('default', async () => {
      const { client } = await openSession();
      let nuevos = 0, errores = 0;
      for (const p of pend) {
        try {
          const r = await client.enqueue(() => readRndc(client, p.manifiesto));
          if (r) {
            await saveRndc(p.token_id, r);
            if (r.radicado) nuevos++;
          }
        } catch {
          errores++;
        }
      }
      return { nuevos, errores };
    });
    res.status(200).json({ ok: true, revisados: pend.length, nuevosRadicados: nuevos, errores });
  } catch (e) {
    sendError(res, e);
  }
}
