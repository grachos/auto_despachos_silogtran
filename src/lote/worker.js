// M7.2: batch preparation queue. ONE row per invocation (Vercel Hobby kills a function at 60 s and a preparation takes 12-19 s), always in
// series (they share the person's Silogtran session lock: «Quitar Todos» of one row would wipe the pending of another). Each invocation
// prepares its row WITHOUT saving anything, then asks /api/internal/lote (a fresh invocation, signed token) for the next one; after the last
// row it sends ONE summary to the person. A bad row never stops the others.
import { signToken } from '../token.js';
import { ApiError } from '../http/errors.js';
import * as lotes from '../store/lotes.js';
import { createPending } from '../store/ia.js';
import { prepareDispatch } from '../dispatch/service.js';
import { sendText, sendButtons } from '../whatsapp/api.js';
import { FIXED_REPLIES } from '../ai/tools.js';
import { chooseBatchAdvance } from './advance.js';
import { loteSummaryText } from './summary.js';

export const MAX_BUSY_ATTEMPTS = 3; // a row that finds the session busy (the person is doing something else) is retried a few times

const baseUrl = () => process.env.PUBLIC_BASE_URL || 'https://auto-despachos-silogtran.vercel.app';

// Asks for the preparation of row `n` in a fresh invocation. Returns true when the request was accepted (never throws).
export async function kickLoteStep(loteId, n) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const t = signToken({ l: loteId, n }, 300, 'lote-step');
      const res = await fetch(`${baseUrl()}/api/internal/lote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t }), signal: AbortSignal.timeout(8_000) });
      if (res.ok) return true;
      console.error('[lote] kick failed:', res.status);
    } catch (e) {
      console.error('[lote] kick failed:', e?.code || e?.name || 'error');
    }
  }
  return false;
}

export const realDeps = {
  store: lotes,
  prepareDispatch,
  createPending,
  kick: kickLoteStep,
  send: sendText,
  sendButtons,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

function rejection(e) {
  const code = e?.code || 'INTERNAL_ERROR';
  if (Object.hasOwn(FIXED_REPLIES, code)) return { code, text: FIXED_REPLIES[code] };
  if (e instanceof ApiError) return { code, text: String(e.message || 'no se pudo preparar.').slice(0, 300) };
  return { code: 'INTERNAL_ERROR', text: 'ocurrió un error inesperado al prepararla; envíala de nuevo.' };
}

// Prepares row `n` of a batch and chains to the next one (or sends the final summary). Idempotent: a row already taken is skipped.
export async function runLoteStep({ l: loteId, n }, d = realDeps) {
  const lote = await d.store.getLote(loteId);
  if (!lote || lote.status !== 'PREPARING') return; // cancelled, superseded or already finished
  const item = await d.store.claimItem(loteId, n);
  if (!item) return;
  const t0 = d.now();
  let patch;
  try {
    const r = await d.prepareDispatch(lote.user_id, item.numero, item.input, { precheckPlate: true });
    if (r.plate === 'missing') patch = { status: 'REJECTED', error_code: 'PLATE_NOT_FOUND', error_text: `no encontré la placa ${String(item.input.placa).replace(/[^A-Z0-9]/gi, '')} en Silogtran; revisa cómo está escrita.` };
    else if (r.plate === 'inactive') patch = { status: 'REJECTED', error_code: 'PLATE_INACTIVE', error_text: `la placa ${String(item.input.placa).replace(/[^A-Z0-9]/gi, '')} está INACTIVA en Silogtran; pide que la activen.` };
    else {
      const choice = chooseBatchAdvance(r.resumen, item.input);
      if (!choice.ok) patch = { status: 'REJECTED', error_code: choice.code, error_text: choice.text };
      else if ((await d.store.getLote(loteId))?.status !== 'PREPARING') patch = { status: 'CANCELLED' }; // cancelled while this row was being prepared
      else {
        const resumen = r.resumen;
        resumen.lote = { id: loteId, n };
        if (choice.eleccion) resumen.eleccion = choice.eleccion; // external: beneficiary + amount, exactly as the single flow stores them
        else resumen.loteAnticipo = choice.interno; // internal: 'cero' | 'total'
        const pendienteId = await d.createPending(lote.user_id, { numero: item.numero, token: r.token, resumen, anticipo: resumen.anticipoSugerido }, { loteId });
        patch = { status: 'READY', pendiente_id: pendienteId };
      }
    }
  } catch (e) {
    if (e?.code === 'USER_BUSY' && item.attempts < MAX_BUSY_ATTEMPTS) {
      // The session is busy with something else of the person: try this same row again in a moment.
      await d.store.releaseItem(loteId, n);
      await d.sleep(5_000);
      if (await d.kick(loteId, n)) return;
      patch = { status: 'REJECTED', error_code: 'KICK_FAILED', error_text: 'no pude continuar con el lote; envíala de nuevo.' };
    } else {
      const j = rejection(e);
      console.error('[lote] row failed:', j.code);
      patch = { status: 'REJECTED', error_code: j.code, error_text: j.text };
    }
  }
  await d.store.finishItem(loteId, n, { ...patch, ms: d.now() - t0 });

  const next = await d.store.nextPendingItem(loteId);
  if (next) {
    if (await d.kick(loteId, next.n)) return;
    await d.store.rejectPendingItems(loteId, 'KICK_FAILED', 'no alcancé a prepararla; envíala de nuevo.');
  }
  await finishLote(loteId, lote, d);
}

async function sendWithButtons(d, phone, text, buttons) {
  if (!buttons.length) return d.send(phone, text);
  try {
    if (text.length <= 1000) await d.sendButtons(phone, text, buttons);
    else { await d.send(phone, text); await d.sendButtons(phone, 'Puedes cancelar el lote si algo no está bien.', buttons); }
  } catch {
    await d.send(phone, text);
  }
}

async function finishLote(loteId, lote, d) {
  const cur = await d.store.getLote(loteId);
  if (!cur || cur.status !== 'PREPARING') { await d.store.cancelLotePendings?.(loteId); return; } // cancelled meanwhile: nothing stays usable
  await d.store.setLoteStatus(loteId, 'READY', 'PREPARING');
  const items = await d.store.listItems(loteId);
  const ready = items.filter((i) => i.status === 'READY');
  const rows = await d.store.getPendingsByIds(ready.map((i) => i.pendiente_id).filter(Boolean));
  const pendings = new Map(rows.map((p) => [p.id, p.resumen]));
  const text = loteSummaryText(items, pendings);
  await sendWithButtons(d, lote.phone, text, ready.length ? [{ id: `lcan:${loteId}`, title: 'Cancelar lote' }] : []);
}
