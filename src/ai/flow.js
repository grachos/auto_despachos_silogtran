// WhatsApp assistant flow for LINKED users: text turns, voice notes and the confirmation buttons.
//  - Agent turns and button presses of one user are serialized with a per-user chat lock.
//  - Nothing the model says can save: confirming happens ONLY when the user taps a button this server sent.
//  - Everything here runs in the background (waitUntil); on failure the person gets an apology, never silence.
import { runAgentTurn } from './agent.js';
import { makeExecutors } from './tools.js';
import { buildSummaryText, buildButtons, BUTTON_ID, resultText } from './summary.js';

const LIMITS = { msg: Number(process.env.IA_MAX_MSG_HORA) || 40, voz: Number(process.env.IA_MAX_VOZ_HORA) || 15 };

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
// A short "yes"-like phrase ("sí", "sí, confírmalo", "dale, confirmo"). Anything with other words ("sí pero cambia la placa") is NOT one.
const YES_KEY = new Set(['si', 'claro', 'dale', 'ok', 'okay', 'listo', 'va', 'hagale', 'confirmo', 'confirma', 'confirmalo', 'confirmarlo', 'confirmar']);
const YES_FILLER = new Set(['de', 'una', 'por', 'favor', 'ya', 'gracias', 'entonces']);
export const isBareConfirm = (t) => {
  const w = norm(t).split(' ').filter(Boolean);
  return w.length > 0 && w.length <= 5 && w.every((x) => YES_KEY.has(x) || YES_FILLER.has(x)) && w.some((x) => YES_KEY.has(x));
};
// A bare "no" is NOT a cancel (it may answer another question of the assistant).
export const isBareCancel = (t) => /^(cancelar|cancela|cancelalo|olvidalo)$/.test(norm(t));

const T = {
  noAi: (n) => `Hola ${n} 👋 Tu cuenta está vinculada, pero el asistente conversacional aún no está habilitado. Mientras tanto puedes revisar el manual: ${process.env.PUBLIC_BASE_URL || 'https://auto-despachos-silogtran.vercel.app'}/manual`,
  noVoice: 'Por ahora no puedo escuchar notas de voz. Escríbeme el despacho, por ejemplo: «Despacha la solicitud 0101072807 con la placa KNL058».',
  limit: 'Has enviado muchos mensajes seguidos. Espera un rato e intenta de nuevo.',
  busyChat: 'Sigo con tu mensaje anterior. Dame unos segundos y vuelve a escribir.',
  apology: 'Tuve un problema procesando tu mensaje. Intenta de nuevo en un momento.',
  cancelled: 'Listo, cancelé ese despacho. No se grabó nada.',
  voiceFail: 'No pude procesar tu nota de voz. Intenta de nuevo o escríbeme el mensaje.',
  voiceLong: 'Tu nota de voz es demasiado larga. Envíala más corta o escríbeme el mensaje.',
  voiceEmpty: 'No entendí la nota de voz. Intenta de nuevo hablando un poco más cerca, o escríbeme el mensaje.',
  resend: 'Para confirmar usa los botones del resumen. Te lo envío de nuevo:',
  buttonUnknown: 'No reconocí esa opción. Pídeme el despacho de nuevo.',
};

const EXPLAIN = {
  PROCESSING: 'Ya estoy procesando tu confirmación; espera unos segundos.',
  USED: 'Ese despacho ya fue confirmado.',
  CANCELLED: 'Ese despacho fue cancelado.',
  SUPERSEDED: 'Ese resumen ya no está vigente: pediste otro después. Usa los botones del más reciente.',
  EXPIRED: 'Ese resumen venció (dura 15 minutos). Pídeme el despacho de nuevo.',
  NOT_FOUND: 'No encontré ese despacho. Pídemelo de nuevo.',
};

// Confirm errors: deterministic text and the final state of the pending row (default: back to PENDING so the button can be tapped again).
const CONFIRM_ERRORS = {
  ANTICIPO_CHANGED: { text: 'El anticipo cambió desde que preparé el resumen. Pídeme el despacho de nuevo para ver el valor actualizado.', final: 'SUPERSEDED' },
  TOKEN_EXPIRED: { text: 'El resumen venció (dura 15 minutos). Pídeme el despacho de nuevo.', final: 'SUPERSEDED' },
  TOKEN_INVALID: { text: 'No pude validar ese resumen. Pídeme el despacho de nuevo.', final: 'SUPERSEDED' },
  USER_BUSY: { text: 'Hay otra operación tuya en curso; espera unos segundos y vuelve a pulsar el botón.' },
  SOLICITUD_LOCKED: { text: 'Esa solicitud se está procesando ahora mismo; espera unos segundos y vuelve a pulsar el botón.' },
  CONFIRMATION_IN_PROGRESS: { text: 'Esa confirmación ya está en proceso; espera unos segundos y vuelve a pulsar el botón.' },
  CONFIRMATION_UNKNOWN: { text: 'No puedo confirmar si Silogtran guardó el despacho. Revísalo en Silogtran antes de repetirlo.', final: 'USED' },
  SAVE_RESULT_UNKNOWN: { text: 'No puedo confirmar si Silogtran guardó el despacho. Revísalo en Silogtran antes de repetirlo.', final: 'USED' },
  SAVE_REJECTED: { text: 'Silogtran no guardó el despacho. Revisa los datos y pídemelo de nuevo.', final: 'USED' },
  RELINK_REQUIRED: { text: 'Tu usuario o contraseña de Silogtran ya no son válidos. Pide un link nuevo al administrador y vuelve a ingresar.', final: 'SUPERSEDED' },
  CREDENTIALS_INVALID: { text: 'Tu usuario o contraseña de Silogtran ya no son válidos. Pide un link nuevo al administrador y vuelve a ingresar.', final: 'SUPERSEDED' },
};

// d: { ia, chat, transcribe, downloadMedia, confirmDispatch, withLock, send(phone,text), sendButtons(phone,body,buttons), aiAvailable(), now(), services? }
export function createFlow(d) {
  const log = (what, e) => console.error(`[ai] ${what}:`, e?.code || e?.name || 'error'); // codes only, never message text

  async function safe(phone, fn) {
    try {
      await fn();
    } catch (e) {
      log('failed', e);
      try { await d.send(phone, T.apology); } catch (e2) { log('apology not sent', e2); }
    }
  }

  async function underChatLock(phone, link, fn) {
    let locked = true;
    try {
      return await d.withLock(`chat:${link.userId}`, async () => { locked = false; return fn(); });
    } catch (e) {
      if (locked && e?.code === 'USER_BUSY') return void (await d.send(phone, T.busyChat));
      throw e;
    }
  }

  async function sendSummary(phone, pendingId, resumen, lead) {
    if (lead) await d.send(phone, lead);
    const text = buildSummaryText(resumen);
    const buttons = buildButtons(pendingId, resumen.anticipoSugerido);
    if (text.length <= 1000) await d.sendButtons(phone, text, buttons);
    else { await d.send(phone, text); await d.sendButtons(phone, '¿Confirmo el despacho?', buttons); }
  }

  async function turn(phone, link, text) {
    const uid = link.userId;
    const history = await d.ia.recentHistory(uid);
    const out = await runAgentTurn(
      { nombre: link.nombre, text, history, now: d.now() },
      { chat: d.chat, executors: makeExecutors({ userId: uid, send: (t) => d.send(phone, t), services: d.services }) },
    );
    await d.ia.addMessage(uid, 'user', text);
    if (out.kind === 'pending') {
      await d.ia.addMessage(uid, 'assistant', `Preparé el despacho de la solicitud ${out.numero}; estoy esperando que confirmes con los botones.`);
      await sendSummary(phone, out.id, out.resumen);
    } else {
      await d.ia.addMessage(uid, 'assistant', out.text);
      await d.send(phone, out.text);
    }
    d.ia.pruneOld(uid).catch(() => {});
  }

  // A typed/spoken "sí" never confirms: it re-sends the buttons. A typed "cancelar" cancels the pending one.
  async function typedAnswer(phone, link, text) {
    const pend = await d.ia.latestPending(link.userId);
    if (!pend) return false;
    if (isBareConfirm(text)) { await sendSummary(phone, pend.id, pend.resumen, T.resend); return true; }
    if (isBareCancel(text)) { await d.ia.cancelPending(pend.id, link.userId); await d.send(phone, T.cancelled); return true; }
    return false;
  }

  async function onText({ phone, link, text }) {
    if (!d.aiAvailable()) return void (await d.send(phone, T.noAi(link.nombre)));
    await safe(phone, async () => {
      if ((await d.ia.usageCount(link.userId, 'msg')) >= LIMITS.msg) return void (await d.send(phone, T.limit));
      await underChatLock(phone, link, async () => {
        if (await typedAnswer(phone, link, text)) return;
        await d.ia.recordUsage(link.userId, 'msg');
        await turn(phone, link, text);
      });
    });
  }

  async function onVoice({ phone, link, mediaId }) {
    if (!d.aiAvailable()) return void (await d.send(phone, T.noVoice));
    await safe(phone, async () => {
      if ((await d.ia.usageCount(link.userId, 'voz')) >= LIMITS.voz) return void (await d.send(phone, T.limit));
      await underChatLock(phone, link, async () => {
        await d.ia.recordUsage(link.userId, 'voz');
        await d.send(phone, '🎙️ Escuchando tu nota de voz…');
        let transcript;
        try {
          const { data, mime } = await d.downloadMedia(mediaId);
          transcript = await d.transcribe(data, mime);
        } catch (e) {
          log('voice', e);
          return void (await d.send(phone, e?.code === 'MEDIA_TOO_LARGE' ? T.voiceLong : T.voiceFail));
        }
        if (!transcript) return void (await d.send(phone, T.voiceEmpty));
        await d.send(phone, `🎙️ Entendí: «${transcript}»`); // deterministic echo: a misheard plate/number is visible right away
        if (await typedAnswer(phone, link, transcript)) return;
        await d.ia.recordUsage(link.userId, 'msg');
        await turn(phone, link, transcript);
      });
    });
  }

  async function explain(id, uid) {
    const row = await d.ia.getPending(id);
    return EXPLAIN[d.pendingProblem(row, uid)] ?? 'No pude usar ese botón. Pídeme el despacho de nuevo.';
  }

  async function onButton({ phone, link, buttonId }) {
    const m = BUTTON_ID.exec(String(buttonId));
    if (!m) return void (await d.send(phone, T.buttonUnknown));
    const [, kind, id] = m;
    const uid = link.userId;
    await safe(phone, () =>
      underChatLock(phone, link, async () => {
        if (kind === 'canc') return void (await d.send(phone, (await d.ia.cancelPending(id, uid)) ? T.cancelled : await explain(id, uid)));
        const row = await d.ia.claimPending(id, uid); // atomic: owner + still PENDING + not expired + latest (older ones are SUPERSEDED)
        if (!row) return void (await d.send(phone, await explain(id, uid)));
        await d.send(phone, '⏳ Confirmando el despacho en Silogtran… puede tardar hasta un minuto.');
        try {
          const r = await d.confirmDispatch(row.numero, { token: row.token, anticipo: kind === 'ctot' ? 'total' : 'cero' });
          await d.ia.finishPending(id, 'USED');
          await d.send(phone, resultText(r));
        } catch (e) {
          log('confirm', e);
          const map = CONFIRM_ERRORS[e?.code];
          await d.ia.finishPending(id, map?.final ?? 'PENDING');
          await d.send(phone, map?.text ?? `No pude completar el despacho (código ${e?.code ?? 'ERROR'}). Puedes volver a pulsar el botón en unos minutos.`);
        }
      }),
    );
  }

  return { onText, onVoice, onButton };
}
