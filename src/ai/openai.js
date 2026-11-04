// Minimal OpenAI client (fetch, no SDK): chat with tool calling and audio transcription.
// Env: OPENAI_API_KEY (or IA_API_KEY, same name as SICE Query), IA_MODELO (default gpt-4.1-mini),
// IA_MODELO_RESPALDO (default gpt-4o-mini, used when the model is not found), STT_MODELO (default gpt-4o-mini-transcribe).
import { ApiError } from '../http/errors.js';

const BASE = 'https://api.openai.com/v1';
export const aiKey = () => process.env.OPENAI_API_KEY || process.env.IA_API_KEY || '';
export const aiAvailable = () => Boolean(aiKey());
const models = () => [...new Set([process.env.IA_MODELO || 'gpt-4.1-mini', process.env.IA_MODELO_RESPALDO || 'gpt-4o-mini'])];

const VOCAB =
  'Despacho de transporte de carga en Colombia: solicitud de transporte (números como 0101072807), placa del vehículo (tres letras y tres números, por ejemplo KNL058), ' +
  'cita de cargue, cita de descargue, contenedor (cuatro letras y siete dígitos, por ejemplo WHSU545823-0), BL, manifiesto general, manifiesto municipal o urbano, ' +
  'anticipo total o cero, Santa Marta, Barranquilla, Cartagena, Bogotá, Buenaventura, Medellín, Cali.';

// Returns the assistant message ({ content, tool_calls }). Falls back to the next model when one is retired.
export async function chatComplete({ messages, tools, timeoutMs = 25_000 }) {
  let last;
  for (const model of models()) {
    let res;
    try {
      res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${aiKey()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', parallel_tool_calls: false, temperature: 0.2, max_tokens: 500 }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new ApiError('AI_FAILED', 'No se pudo contactar al modelo de IA.', { status: 502, detail: e?.name || 'network' });
    }
    if (res.ok) return (await res.json()).choices?.[0]?.message ?? { content: '' };
    const body = (await res.text().catch(() => '')).slice(0, 300);
    last = `HTTP ${res.status} ${body}`;
    if (res.status === 404 || (res.status === 400 && /model/i.test(body))) continue; // retired/unknown model: try the next one
    break;
  }
  throw new ApiError('AI_FAILED', 'El modelo de IA no respondió correctamente.', { status: 502, detail: last });
}

const EXT = { 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'm4a', 'audio/amr': 'amr', 'audio/webm': 'webm', 'audio/wav': 'wav' };

export function cleanTranscript(t) {
  return String(t ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000);
}

export async function transcribe(audio, mime) {
  const base = String(mime || 'audio/ogg').split(';')[0].trim().toLowerCase(); // strip ";codecs=opus"
  const form = new FormData();
  form.append('file', new Blob([audio], { type: base }), `voz.${EXT[base] ?? 'ogg'}`);
  form.append('model', process.env.STT_MODELO || 'gpt-4o-mini-transcribe');
  form.append('language', 'es');
  form.append('temperature', '0');
  form.append('prompt', VOCAB);
  let res;
  try {
    res = await fetch(`${BASE}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${aiKey()}` }, body: form, signal: AbortSignal.timeout(25_000) });
  } catch (e) {
    throw new ApiError('TRANSCRIBE_FAILED', 'No se pudo transcribir el audio.', { status: 502, detail: e?.name || 'network' });
  }
  if (!res.ok) throw new ApiError('TRANSCRIBE_FAILED', 'No se pudo transcribir el audio.', { status: 502, detail: `HTTP ${res.status}` });
  return cleanTranscript((await res.json()).text);
}
