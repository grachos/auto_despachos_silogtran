// Meta signs every webhook POST: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(App Secret, raw body).
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySignature(rawBody, header, secret) {
  if (!secret || !header || !Buffer.isBuffer(rawBody)) return false;
  const expected = Buffer.from('sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex'));
  const given = Buffer.from(String(header));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Constant-time string equality (for the webhook verify token).
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}
