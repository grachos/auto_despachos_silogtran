// Incoming WhatsApp messages: linking (VINCULAR), AYUDA, DESVINCULAR. Anything else is for the AI assistant (M5).
// Replies never echo user-provided text.
import { parseCommand } from './commands.js';
import { MAX_FAILED_PER_HOUR } from '../store/whatsapp.js';

const base = () => process.env.PUBLIC_BASE_URL || 'https://auto-despachos-silogtran.vercel.app';

const T = {
  welcome: (n) => `✅ ¡Listo, ${n}! Tu WhatsApp quedó vinculado.\n\nAquí está el manual con todo lo que necesitas para despachar:\n${base()}/manual\n\nEscribe AYUDA cuando lo necesites o DESVINCULAR para quitar este número.`,
  help: `Soy el asistente de despachos de Silogtran.\n\n• AYUDA: este mensaje\n• DESVINCULAR: quita este número de tu cuenta\n\nManual de despachos:\n${base()}/manual`,
  unlinked: `Hola 👋 Este número aún no está vinculado a una cuenta de despachos.\n\nEntra con tu link de acceso, pulsa "Vincular teléfono" y envíame el código que te muestre (por ejemplo: VINCULAR 123456).\n\nManual:\n${base()}/manual`,
  linkedSoon: (n) => `Hola ${n} 👋 Tu cuenta está vinculada. El asistente conversacional de despachos estará disponible muy pronto.\n\nMientras tanto puedes revisar el manual:\n${base()}/manual`,
  badCode: 'Ese código no es válido o ya venció. Genera uno nuevo en la página de vinculación y envíalo de nuevo.',
  badFormat: 'Para vincular tu cuenta envía: VINCULAR seguido de los 6 dígitos del código. Ejemplo: VINCULAR 123456',
  locked: 'Demasiados intentos con códigos incorrectos. Espera una hora e intenta de nuevo.',
  inactive: 'Tu cuenta no está activa. Pide un link nuevo al administrador.',
  unlinkedOk: 'Listo, desvinculé este número. Para volver a usar el asistente, vincúlalo de nuevo desde la página de vinculación.',
  notLinked: 'Este número no estaba vinculado a ninguna cuenta.',
  textOnly: 'Por ahora solo entiendo mensajes de texto.',
};

// deps: { store, getUser, send }
export async function handleMessage(msg, deps) {
  const { store, getUser, send } = deps;
  if (!(await store.markSeen(msg.id))) return 'duplicate';
  try {
    const reply = (t) => send(msg.from, t);
    if (msg.type !== 'text') {
      await reply(T.textOnly);
      return 'non-text';
    }
    const c = parseCommand(msg.text?.body);

    if (c.cmd === 'link') {
      if ((await store.failedAttempts(msg.from)) >= MAX_FAILED_PER_HOUR) return void (await reply(T.locked)), 'locked';
      const userId = await store.consumeCode(c.code);
      if (!userId) {
        await store.recordFail(msg.from);
        await reply(T.badCode);
        return 'bad-code';
      }
      const user = await getUser(userId);
      if (!user || user.status !== 'ACTIVE') return void (await reply(T.inactive)), 'inactive';
      await store.linkPhone(userId, msg.from);
      await reply(T.welcome(user.nombre));
      return 'linked';
    }
    if (c.cmd === 'link_bad') return void (await reply(T.badFormat)), 'bad-format';
    if (c.cmd === 'help') return void (await reply(T.help)), 'help';

    const link = await store.getLinkByPhone(msg.from);
    if (c.cmd === 'unlink') {
      await reply((await store.unlinkPhone(msg.from)) ? T.unlinkedOk : T.notLinked);
      return 'unlink';
    }
    if (!link) return void (await reply(T.unlinked)), 'unlinked';
    if (link.status !== 'ACTIVE') return void (await reply(T.inactive)), 'inactive';
    await reply(T.linkedSoon(link.nombre)); // placeholder until the AI assistant (M5)
    return 'linked-text';
  } catch (e) {
    await store.unmarkSeen(msg.id).catch(() => {}); // let Meta's retry process it again
    throw e;
  }
}

// Text messages for our phone number only, from the webhook payload.
export function extractMessages(payload, phoneId) {
  if (payload?.object !== 'whatsapp_business_account') return [];
  const out = [];
  for (const entry of payload.entry ?? []) {
    for (const ch of entry.changes ?? []) {
      const v = ch.value;
      if (ch.field !== 'messages' || !v || String(v.metadata?.phone_number_id) !== String(phoneId)) continue;
      for (const m of v.messages ?? []) {
        if (m?.id && m?.from) out.push({ id: m.id, from: String(m.from), type: m.type, text: m.text });
      }
    }
  }
  return out;
}
