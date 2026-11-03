// WhatsApp Cloud API webhook.
//   GET  — Meta's verification handshake (hub.mode / hub.verify_token / hub.challenge).
//   POST — incoming messages; the signature (X-Hub-Signature-256) is verified against the RAW body first.
import { sendError, ApiError } from '../../src/http/errors.js';
import { requireEnv } from '../../src/config.js';
import { verifySignature, safeEqual } from '../../src/whatsapp/signature.js';
import { handleMessage, extractMessages } from '../../src/whatsapp/handler.js';
import { realDeps } from '../../src/whatsapp/deps.js';

export const config = { api: { bodyParser: false } }; // we need the exact bytes Meta signed

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}

export function createHandler(deps = realDeps) {
  return async function handler(req, res) {
    res.setHeader('cache-control', 'no-store');
    try {
      if (req.method === 'GET') {
        requireEnv('WHATSAPP_VERIFY_TOKEN');
        const q = req.query || {};
        if (q['hub.mode'] === 'subscribe' && safeEqual(q['hub.verify_token'], process.env.WHATSAPP_VERIFY_TOKEN) && q['hub.challenge']) {
          res.setHeader('content-type', 'text/plain');
          return res.status(200).send(String(q['hub.challenge']));
        }
        return res.status(403).json({ ok: false, code: 'VERIFY_FAILED', message: 'Token de verificación inválido.' });
      }
      if (req.method !== 'POST') {
        res.setHeader('allow', 'GET, POST');
        return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Use GET o POST.' });
      }

      requireEnv('WHATSAPP_APP_SECRET', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'TOKEN_SECRET');
      const raw = await readRaw(req);
      if (!verifySignature(raw, req.headers['x-hub-signature-256'], process.env.WHATSAPP_APP_SECRET)) {
        console.error('[whatsapp] invalid signature');
        throw new ApiError('SIGNATURE_INVALID', 'Firma inválida.', { status: 401 });
      }
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new ApiError('INVALID_PARAMETER', 'Cuerpo inválido.', { status: 400 });
      }

      let failed = 0;
      for (const msg of extractMessages(payload, process.env.WHATSAPP_PHONE_ID)) {
        try {
          await handleMessage(msg, deps);
        } catch (e) {
          failed++;
          console.error('[whatsapp] message failed:', e?.code || e?.message); // never log message text or codes
        }
      }
      // 500 makes Meta retry the failed ones later (they were un-marked as seen).
      return res.status(failed ? 500 : 200).json({ ok: !failed });
    } catch (e) {
      sendError(res, e);
    }
  };
}

export default createHandler();
