// Helpers for the bot's WhatsApp number (env WHATSAPP_NUMBER, digits with country code, e.g. 573227186938).
export const botDigits = () => String(process.env.WHATSAPP_NUMBER || '').replace(/\D/g, '');

export function botDisplay() {
  const d = botDigits();
  const m = /^57(\d{3})(\d{3})(\d{4})$/.exec(d);
  return m ? `+57 ${m[1]} ${m[2]} ${m[3]}` : d ? `+${d}` : null;
}

export const waLink = (text) => (botDigits() ? `https://wa.me/${botDigits()}?text=${encodeURIComponent(text)}` : null);
