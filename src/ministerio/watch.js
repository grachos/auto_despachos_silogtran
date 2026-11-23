// Background watcher: after a Vehículos Activos dispatch is saved, wait for the Ministry (RNDC) filing number and tell the person.
// The Ministry can take 30-60 s, which does not fit in the dispatch request (it already uses ~35 of Vercel's 60 s), so the dispatch
// answers first and this runs afterwards in its own invocation(s): up to MAX_ATTEMPTS invocations of ~45 s each, chained through
// /api/internal/ministerio (signed token). Empresas trips never reach this (they are not reported to the Ministry).
//   radicado -> "✅ Manifiesto N: el radicado del Ministerio es R. Subió al Ministerio sin inconvenientes."
//   nothing after the whole wait -> "⚠️ El manifiesto N no subió al Ministerio. Revisa las causas en Silogtran."
import { signToken } from '../token.js';
import { withLock } from '../store/locks.js';
import { openActorSession, sessionKey } from '../silogtran/userSession.js';
import { readRndc } from '../silogtran/grabar.js';
import { claimRndcNotice, saveRndc } from '../store/admin.js';
import { sendText, sendButtons, sendLinkButton } from '../whatsapp/api.js';
import { getManifestPdfUrl } from '../silogtran/imprimir.js';
import { resendToMinistry } from './resend.js';

export const TICK_MS = 8_000; // between readings
export const BUDGET_MS = 48_000; // per invocation (Vercel kills the function at 60 s)
export const MAX_ATTEMPTS = 2; // reading invocations, ~100 s in total; then one more invocation explains the failure (EXPLAIN_ATTEMPT)
export const EXPLAIN_ATTEMPT = MAX_ATTEMPTS + 1;
// The fresh PDF (with the QR code) is made in ITS OWN invocation: when the radicado shows up late in a reading invocation (e.g. 40 s in)
// the print button (10-20 s) did not fit in Vercel's 60 s and the function was killed silently (manifest 0101228253, 2026-11-19).
export const PDF_STEP = 'pdf';

const baseUrl = () => process.env.PUBLIC_BASE_URL || 'https://auto-despachos-silogtran.vercel.app';

export const successText = (m, radicado) => `✅ Manifiesto ${m}: el radicado del Ministerio es ${radicado}. Subió al Ministerio sin inconvenientes.`;
export const failureText = (m) => `⚠️ El manifiesto ${m} no subió al Ministerio. Revisa las causas en Silogtran.`;

// Known Ministry rejections with a plain-language tip (the Ministry's own text is always shown too).
const TIPS = [[/MAN157/i, 'Tip: es un viaje dentro del mismo municipio; el tipo de manifiesto debe ser «urbano/municipal». Corrígelo en Silogtran.']];

// After the wait, one resend (the same «Enviar Ministerio» button) reads the Ministry's report: it says WHY it was not filed.
export function explainText(m, r) {
  if (r?.estado === 'RADICADO') {
    return [`✅ Manifiesto ${m}: el radicado del Ministerio es ${r.radicado}. Subió al reenviarlo.`, ...(r.pdf ? [`📄 Manifiesto en PDF (con el código QR): ${r.pdf}`] : [])].join('\n');
  }
  const errs = (r?.informe?.secciones ?? []).filter((s) => s.estado === 'ERROR').flatMap((s) => s.errores.map((e) => `• ${s.nombre}: ${e}`)).slice(0, 5);
  if (!errs.length && (r?.informe?.secciones ?? []).length && r.informe.secciones.every((s) => s.estado === 'SIN_INFORMACION')) {
    return `ℹ️ El manifiesto ${m}: el Ministerio no tiene nada pendiente por recibir (suele indicar que ya lo registró). Revisa en Silogtran si ya tiene radicado.`;
  }
  if (!errs.length) return failureText(m);
  const tips = TIPS.filter(([re]) => errs.some((e) => re.test(e))).map(([, t]) => t);
  return [`⚠️ El manifiesto ${m} no subió al Ministerio.`, 'El Ministerio informa:', ...errs, ...tips].join('\n');
}

// «Reenviar al Ministerio» (same as the «Enviar Ministerio» button in Silogtran): WhatsApp reply button, typed request and MCP tool.
export const RESEND_ID = /^rmin:(\d{3,20})$/;
export const resendButton = (m) => [{ id: `rmin:${m}`, title: 'Reenviar Ministerio' }];
const plain = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// A typed request like «reenvía el manifiesto 0101227492 al Ministerio» / «sube al ministerio el 0101227492».
// null = not a resend request (the assistant handles the text); { manifiesto } = exactly one number; { manifiesto:null, varios } = ask.
export function parseResendRequest(text) {
  const t = plain(text);
  if (/\b(solicitud|placa)\b/.test(t)) return null; // a dispatch request, not a resend
  const verb = /\b(re ?envi\w*|envi\w*|sub\w*|migr\w*|report\w*)\b/.test(t);
  const intent = (verb && /\b(ministerio|rndc)\b/.test(t)) || (/\bre ?envi\w*/.test(t) && /\bmanifiesto\b/.test(t));
  if (!intent) return null;
  const nums = [...new Set(t.match(/\b\d{6,20}\b/g) ?? [])];
  return nums.length === 1 ? { manifiesto: nums[0] } : { manifiesto: null, varios: nums.length > 1 };
}

// Reply after a resend (WhatsApp and MCP). The PDF link is added by the caller (WhatsApp sends it as a button).
export function resendReplyText(m, r) {
  if (r?.estado === 'RADICADO') {
    return r.yaTeniaRadicado ? `✅ El manifiesto ${m} ya tenía radicado del Ministerio: ${r.radicado}. No hace falta reenviarlo.` : explainText(m, { ...r, pdf: null });
  }
  const left = Number(r?.intentosRestantes ?? 0);
  return [explainText(m, r), left > 0 ? `Cuando lo corrijas en Silogtran puedes reenviarlo de nuevo (quedan ${left} reenvíos).` : 'Ya no quedan reenvíos desde aquí; revísalo en Silogtran.'].join('\n');
}

// One reading with the owner's own Silogtran session. The session lock is held only for the reading (not for the whole wait), so the
// person can keep working; if it is busy the tick is simply skipped.
async function readOnce(uid, manifiesto) {
  return withLock(sessionKey(uid), async () => {
    const { client } = await openActorSession(uid);
    return client.enqueue(() => readRndc(client, manifiesto));
  });
}

// Asks the internal endpoint (a fresh invocation with its own 60 s) to start/continue a watch. Never throws.
export async function startMinistryWatch({ phone, manifiesto, jti, uid, attempt = 1, step = null }) {
  try {
    const t = signToken({ m: manifiesto, j: jti ?? null, u: uid ?? null, p: phone, a: attempt, ...(step ? { k: step } : {}) }, 300, 'rndc-watch');
    const res = await fetch(`${baseUrl()}/api/internal/ministerio`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t }), signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) console.error('[ministerio] start failed:', res.status);
  } catch (e) {
    console.error('[ministerio] start failed:', e?.code || e?.name || 'error');
  }
}

// The PDF generated when the dispatch was confirmed has no QR code (there was no radicado yet) and files are static: once the radicado
// exists a NEW one is generated (same «Imprimir Ministerio 2026» button), with the owner's own session.
async function regeneratePdf(uid, manifiesto) {
  return withLock(sessionKey(uid), async () => {
    const { client } = await openActorSession(uid);
    return client.enqueue(() => getManifestPdfUrl(client, manifiesto));
  });
}

export const realDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  readOnce,
  saveRndc,
  claimNotice: claimRndcNotice,
  send: sendText,
  sendButtons,
  invoke: startMinistryWatch,
  resend: resendToMinistry,
  pdf: regeneratePdf,
  sendLink: sendLinkButton,
};

async function notify(p, d, text, buttons = null) {
  // Exactly once per dispatch, even if two invocations overlap. Returns true when this call sent the notice.
  if (p.j && !(await d.claimNotice(p.j))) return false;
  if (buttons && d.sendButtons) await d.sendButtons(p.p, text, buttons).catch(() => d.send(p.p, text));
  else await d.send(p.p, text);
  return true;
}

// After the «filed» notice: a fresh PDF (it now carries the QR code) as a button. Best effort: never breaks the notice already sent.
async function sendFreshPdf(p, d) {
  if (!d.pdf || !d.sendLink) return;
  try {
    const url = await d.pdf(p.u ?? null, p.m);
    console.log(`[ministerio] fresh pdf: ${url ? 'sent' : 'no link'}`);
    if (url) await d.sendLink(p.p, `📄 Manifiesto ${p.m} con el código QR del Ministerio. Imprime este (el anterior se generó antes del radicado y no lo trae).`, 'Imprimir manifiesto', url);
  } catch (e) {
    console.error('[ministerio] fresh pdf failed:', e?.code || e?.name || 'error');
  }
}

async function explain(p, d) {
  let r = null;
  try { r = await d.resend(p.u ?? null, p.m); } catch (e) { console.error('[ministerio] resend failed:', e?.code || e?.name || 'error'); }
  const withButton = r?.estado === 'RADICADO' && r.pdf && d.sendLink;
  // Not filed and resends left: offer «Reenviar Ministerio» (after fixing the cause in Silogtran, one tap sends it again).
  const offer = r && r.estado !== 'RADICADO' && Number(r.intentosRestantes) > 0;
  const text = offer ? resendReplyText(p.m, r) : explainText(p.m, withButton ? { ...r, pdf: null } : r);
  const sent = await notify(p, d, text, offer ? resendButton(p.m) : null);
  if (sent && withButton) await d.sendLink(p.p, `📄 Manifiesto ${p.m} con el código QR del Ministerio.`, 'Imprimir manifiesto', r.pdf).catch(() => d.send(p.p, `📄 Manifiesto en PDF (con el código QR): ${r.pdf}`));
}

export async function runMinistryWatch(p, d = realDeps) {
  if (p.k === PDF_STEP) return sendFreshPdf(p, d);
  if ((p.a ?? 1) >= EXPLAIN_ATTEMPT) return explain(p, d);
  const start = d.now();
  while (d.now() - start + TICK_MS < BUDGET_MS) {
    await d.sleep(TICK_MS);
    let r = null;
    try { r = await d.readOnce(p.u ?? null, p.m); } catch { /* busy session / transient error: next tick */ }
    if (r?.migrated) {
      if (p.j) await d.saveRndc(p.j, r).catch(() => {});
      if ((await notify(p, d, successText(p.m, r.radicado))) && d.pdf) {
        await d.invoke({ phone: p.p, manifiesto: p.m, jti: p.j, uid: p.u, attempt: p.a ?? 1, step: PDF_STEP });
      }
      return;
    }
  }
  if ((p.a ?? 1) < MAX_ATTEMPTS) return d.invoke({ phone: p.p, manifiesto: p.m, jti: p.j, uid: p.u, attempt: (p.a ?? 1) + 1 });
  if (d.resend) return d.invoke({ phone: p.p, manifiesto: p.m, jti: p.j, uid: p.u, attempt: EXPLAIN_ATTEMPT }); // own invocation: the resend takes ~20 s
  if (p.j) await d.saveRndc(p.j, { migrated: false, radicado: null, fechaHora: null }).catch(() => {}); // marks "checked"
  return notify(p, d, failureText(p.m));
}
