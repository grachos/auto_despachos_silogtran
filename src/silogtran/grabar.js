// Step 11-12: save (Generar), read the generated documents and the RNDC status.
import * as cheerio from 'cheerio';
import { ApiError } from '../http/errors.js';
import { norm } from './text.js';

const P = 'ctl0$MainModule$';
const SAVE_TIMEOUT_SEC = 50; // saving takes 10-18 s in Silogtran

// Structure of an unreadable "Grabar" answer: size, title, whether the form/Grabar button are still there and any
// error-looking message boxes (catalog texts only). Helps to tell a session/page problem from a rejected save.
function fingerprint($, html) {
  const msgs = $('[id*="ensaje"], [class*="error"], [class*="Error"], .mensaje').toArray().map((el) => $(el).text().replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 4).map((t) => t.slice(0, 160));
  // Any visible line that looks like a validation/error notice (PRADO may render it outside the usual message box).
  const body = cheerio.load(String(html));
  body('script, style').remove();
  const notices = [...new Set(body('body').text().split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length > 6 && l.length < 220 && /error|ya existe|debe |seleccion[ea]|no se pudo|no es v[aá]lido|obligatori|requerid|incorrect|inv[aá]lid/i.test(l)))].slice(0, 6);
  // Validators that PRADO re-rendered as VISIBLE (server-side validation failed): map validator id -> ControlToValidate from
  // the page scripts, then keep those whose span is not hidden. Field ids only, no values.
  const control = {};
  for (const m of String(html).matchAll(/'ID':'([^']+)'[^{}]*?'ControlToValidate':'([^']+)'/g)) control[m[1]] = m[2];
  const invalid = Object.keys(control).filter((id) => { const st = String($(`#${id}`).attr('style') ?? ''); return $(`#${id}`).length && !/hidden|display:\s*none/i.test(st); }).map((id) => control[id].replace(/^ctl0_MainModule_/, '')).slice(0, 12);
  return `len=${String(html).length} invalid=${JSON.stringify(invalid)} notices=${JSON.stringify(notices.filter((n) => !/^seleccione uno$/i.test(n)))} title="${($('title').first().text() || '').trim().slice(0, 60)}" generar=${$('[name="ctl0$MainModule$Generar"]').length} form=${$('form').length} hash=${$('#ctl0_MainModule_hash').length} msgs=${JSON.stringify(msgs)}`;
}

export function parseSaveResult(html) {
  const $ = cheerio.load(html);
  const box = $('#ctl0_MainModule_mensaje');
  let text = box.text();
  if (!norm(text).includes('el registro ha sido guardado')) {
    text = $('[id*="ensaje"]').toArray().map((el) => $(el).text()).find((t) => norm(t).includes('el registro ha sido guardado')) ?? text;
  }
  // Drop empty and repeated lines (the message box can repeat the raw Monitor response).
  const lines = [...new Set(text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean))];
  const saved = lines.some((l) => norm(l).includes('el registro ha sido guardado'));
  const rest = lines.filter((l) => !norm(l).includes('el registro ha sido guardado')).join(' ');

  // Generated documents: numeric links classified by the target page in their href.
  const documents = { ordenCargue: null, remesa: null, manifiesto: null, transferencia: null };
  $('a').each((_, a) => {
    const label = $(a).text().trim();
    if (!/^\d+$/.test(label)) return;
    const href = decodeURIComponent($(a).attr('href') || '');
    if (/page=Despacho\.Ordencargue/i.test(href)) documents.ordenCargue ??= label;
    else if (/page=Despacho\.Remesa/i.test(href)) documents.remesa ??= label;
    else if (/page=Despacho\.Manifiesto/i.test(href)) documents.manifiesto ??= label;
    else if (/page=Financiero\.Transferencia/i.test(href)) documents.transferencia ??= label;
  });
  return { saved, warnings: rest ? [rest] : [], documents, rawMessage: lines.join(' | '), fingerprint: fingerprint($, html) };
}

// Posts Generar. Throws SAVE_RESULT_UNKNOWN if the request itself fails (Silogtran may have saved).
export async function postGenerar(client, form) {
  const target = `${P}Generar`;
  try {
    const res = await client.request(form.action, {
      method: 'POST',
      form: { ...form.fields, PRADO_POSTBACK_TARGET: target, [target]: 'Grabar' },
      timeoutSec: SAVE_TIMEOUT_SEC,
    });
    return parseSaveResult(res.text);
  } catch (e) {
    throw new ApiError('SAVE_RESULT_UNKNOWN', 'No se pudo confirmar si Silogtran guardó el despacho. Verifica en Silogtran antes de reintentar.', {
      status: 502,
      detail: e?.message,
    });
  }
}

// Text the Ministry (RNDC) answered for this manifest, shown next to the manifest number: `#ctl0_MainModule_mensajeManifiestoRNDC`
// (the id is known from the page code; its real content still has to be confirmed with a failed manifest). Falls back to any other
// non-input element whose id looks like an RNDC message box. Whitespace collapsed, capped; null when empty.
const tidy = (t) => String(t ?? '').replace(/[\u0000-\u001f\u00a0]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500) || null;
export function rndcMessage($) {
  $('script, style').remove();
  const direct = tidy($('#ctl0_MainModule_mensajeManifiestoRNDC').text());
  if (direct) return direct;
  let found = null;
  $('[id]').each((_, el) => {
    if (found || /^(input|button|select|textarea)$/i.test(el.tagName)) return;
    if (!/mensaje.*rndc|rndc.*mensaje/i.test(el.attribs.id)) return;
    found = tidy($(el).text());
  });
  return found;
}

export function parseRndc(html) {
  const $ = cheerio.load(html);
  const text = $('#ctl0_MainModule_manifiesto_numero').text().replace(/ /g, ' ');
  if (!text.trim()) return null;
  const m = /^\s*(\d+)\s*-\s*(\d+)?/.exec(text);
  const f = /Fecha Hora\s*(\d{4}-\d{2}-\d{2})\s*\/\s*(\d{2}:\d{2}:\d{2})/.exec(text);
  const radicado = m?.[2] ?? null;
  return { migrated: Boolean(radicado), radicado, fechaHora: f ? `${f[1]} ${f[2]}` : null, mensaje: rndcMessage($) };
}

export async function readRndc(client, manifiesto) {
  const res = await client.request(`index.php?page=Despacho.Manifiesto_003.Home_111&manifiesto_codigo=${encodeURIComponent(manifiesto)}`);
  return parseRndc(res.text);
}
