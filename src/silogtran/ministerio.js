// «Enviar Ministerio» (resend a manifest to the Ministry/RNDC). The owner's browser capture shows two steps:
//   1) the plain form submit of the manifest page (empty PRADO_POSTBACK_TARGET/PARAMETER, button name=value, every IDLockHidden_* = true);
//   2) Silogtran hands the browser over to the vendor's Ministry web service with a GET:
//      https://ministerio.colombiasoftware.net/webservice/consumoministerio.php?base=<db>&documento=<manifest>&envio=SI
// We do both. The hand-off URL comes from Silogtran's answer, so it is validated strictly (exact host, https, exact path, same manifest
// number, simple `base`) before our server calls it, and it is called WITHOUT any Silogtran cookie.
// It never presses the button when the manifest already has a filing number (radicado): there is nothing to resend.
import { ApiError } from '../http/errors.js';
import { parseRndc } from './grabar.js';
import { pressPrintButton } from './imprimir.js';

export const SEND_LABEL = 'Enviar Ministerio';
export const MINISTRY_HOST = 'ministerio.colombiasoftware.net';
const MINISTRY_PATH = '/webservice/consumoministerio.php';
const manifestPage = (manifiesto) => `index.php?page=Despacho.Manifiesto_003.Home_111&manifiesto_codigo=${encodeURIComponent(manifiesto)}`;
const tidy = (t, n = 600) => String(t ?? '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// The hand-off URL if (and only if) it is the expected Ministry web-service call for THIS manifest; otherwise null.
export function validMinistryUrl(raw, manifiesto) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== MINISTRY_HOST || u.port || u.username || u.password || u.pathname !== MINISTRY_PATH) return null;
  if (u.searchParams.get('documento') !== String(manifiesto) || !/^[A-Za-z0-9_]{1,60}$/.test(u.searchParams.get('base') ?? '')) return null;
  return u.href;
}

// Finds the hand-off URL in an HTML/JS answer (location.href = '...', window.open('...'), meta refresh, or a plain link).
export function findMinistryUrl(text, manifiesto) {
  for (const m of String(text).matchAll(/https:\/\/ministerio\.colombiasoftware\.net\/webservice\/consumoministerio\.php\?[^\s"'<>\\)]+/gi)) {
    const ok = validMinistryUrl(m[0].replace(/&amp;/g, '&'), manifiesto);
    if (ok) return ok;
  }
  return null;
}

// Short snippets of the press answer around hand-off words (window.open / location / ministerio), to learn how Silogtran builds the
// hand-off when it is not a plain URL. Only code fragments around those words; capped; no other page content.
export function handoffHints(text) {
  const out = [];
  for (const m of String(text).matchAll(/.{0,120}(?:window\.open|location\.(?:href|replace)|consumoministerio|ministerio\.colombiasoftware).{0,160}/gi)) {
    const t = m[0].replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 280); // code fragment: keep tags/script text as is
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 4) break;
  }
  return out;
}

// Returns { skipped: 'ALREADY_MIGRATED', rndc } without pressing, or
// { skipped: null, btn, silogStatus, ministry: { status, url, texto } | null, before }. `ministry` is null when Silogtran gave no hand-off.
export async function sendToMinistry(client, manifiesto, { timeoutSec = 25, ministryTimeoutSec = timeoutSec, fetchImpl = globalThis.fetch, textMax = 600 } = {}) {
  const before = parseRndc((await client.request(manifestPage(manifiesto), { timeoutSec })).text);
  if (before?.migrated) return { skipped: 'ALREADY_MIGRATED', rndc: before };
  let pressed;
  try {
    pressed = await pressPrintButton(client, manifiesto, SEND_LABEL, { timeoutSec, externalRedirect: true });
  } catch (e) {
    if (e?.code === 'PRINT_BUTTON_NOT_FOUND') throw new ApiError('MINISTRY_BUTTON_NOT_FOUND', 'No encontré el botón «Enviar Ministerio» en ese manifiesto (puede que no aplique a este viaje).', { status: 404 });
    throw e;
  }
  const { res, btn } = pressed;
  const target = res.redirectTo ? validMinistryUrl(res.redirectTo, manifiesto) : findMinistryUrl(res.text, manifiesto);
  const out = { skipped: null, btn, silogStatus: res.status, before, ministry: null, handoff: res.redirectTo ? 'redirect' : target ? 'page' : 'none' };
  if (out.handoff === 'none') out.hints = handoffHints(res.text);
  if (res.redirectTo && !target) throw new ApiError('MINISTRY_REDIRECT_UNEXPECTED', 'Silogtran redirigió a una dirección que no es el servicio del Ministerio; no la seguí.', { status: 502 });
  if (!target) return out;
  try {
    const t0 = Date.now();
    const r = await fetchImpl(target, { method: 'GET', redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0', accept: 'text/html' }, signal: AbortSignal.timeout(ministryTimeoutSec * 1000) });
    const body = await r.text();
    // Personal ids in the report are masked; the Ministry codes («CODIGO DEL MINISTERIO …», radicados) are kept.
    out.ministry = { status: r.status, ms: Date.now() - t0, url: `${MINISTRY_HOST}${MINISTRY_PATH}`, bytes: body.length, texto: tidy(body, textMax).replace(/(Documento\s*:\s*)\d+/gi, '$1***') };
  } catch (e) {
    throw new ApiError('MINISTRY_UNREACHABLE', 'No pude comunicarme con el servicio del Ministerio. Intenta de nuevo en un momento.', { status: 502, detail: e?.cause?.code || e?.name });
  }
  return out;
}
