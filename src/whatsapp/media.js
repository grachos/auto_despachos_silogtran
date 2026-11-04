// Downloads a media file received on WhatsApp (voice notes): two steps, both with the Bearer token.
import { ApiError } from '../http/errors.js';

export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

export async function downloadMedia(mediaId, f = fetch) {
  const version = process.env.WHATSAPP_API_VERSION || 'v23.0';
  const auth = { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };
  const fail = (code, msg, detail) => new ApiError(code, msg, { status: 502, detail });
  const meta = await f(`https://graph.facebook.com/${version}/${encodeURIComponent(mediaId)}`, { headers: auth, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!meta?.ok) throw fail('MEDIA_FAILED', 'No se pudo obtener el audio.', `meta HTTP ${meta?.status ?? 'network'}`);
  const info = await meta.json();
  if (!info.url) throw fail('MEDIA_FAILED', 'No se pudo obtener el audio.', 'no url');
  if ((info.file_size ?? 0) > MAX_AUDIO_BYTES) throw new ApiError('MEDIA_TOO_LARGE', 'El audio es demasiado largo.', { status: 413 });
  const file = await f(info.url, { headers: auth, signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!file?.ok) throw fail('MEDIA_FAILED', 'No se pudo descargar el audio.', `file HTTP ${file?.status ?? 'network'}`);
  const data = Buffer.from(await file.arrayBuffer());
  if (data.length > MAX_AUDIO_BYTES) throw new ApiError('MEDIA_TOO_LARGE', 'El audio es demasiado largo.', { status: 413 });
  return { data, mime: info.mime_type || 'audio/ogg' };
}
