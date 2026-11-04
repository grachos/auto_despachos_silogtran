// Sends a text message through the WhatsApp Cloud API. The token never appears in logs or errors.
import { ApiError } from '../http/errors.js';

export async function sendText(to, body) {
  const version = process.env.WHATSAPP_API_VERSION || 'v23.0';
  let res;
  try {
    res = await fetch(`https://graph.facebook.com/${version}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: true, body } }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new ApiError('WHATSAPP_SEND_FAILED', 'No se pudo enviar el mensaje por WhatsApp.', { status: 502, detail: e?.message });
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new ApiError('WHATSAPP_SEND_FAILED', 'WhatsApp rechazó el envío del mensaje.', { status: 502, detail: `HTTP ${res.status} ${detail}` });
  }
}

// Interactive reply buttons (max 3; title <= 20 chars; body <= 1024 chars). Ids come back in `interactive.button_reply.id`.
export async function sendButtons(to, body, buttons) {
  if (buttons.length < 1 || buttons.length > 3) throw new ApiError('INVALID_PARAMETER', 'WhatsApp admite de 1 a 3 botones.', { status: 500 });
  const version = process.env.WHATSAPP_API_VERSION || 'v23.0';
  let res;
  try {
    res = await fetch(`https://graph.facebook.com/${version}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive',
        interactive: { type: 'button', body: { text: String(body).slice(0, 1024) }, action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: String(b.title).slice(0, 20) } })) } },
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new ApiError('WHATSAPP_SEND_FAILED', 'No se pudo enviar el mensaje por WhatsApp.', { status: 502, detail: e?.message });
  }
  if (!res.ok) throw new ApiError('WHATSAPP_SEND_FAILED', 'WhatsApp rechazó el envío del mensaje.', { status: 502, detail: `HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}` });
}
