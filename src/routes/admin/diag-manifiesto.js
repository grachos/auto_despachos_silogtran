// POST /api/admin/diag-manifiesto { manifiesto, usuario?, imprimir? } — READ-ONLY unless `imprimir` (a button label) is sent. Opens the saved manifest page and reports what the page shows about the
// Ministry (RNDC): the number text and every message-looking element (id + text, capped) plus the resend buttons (ids only). Used to learn the
// real structure of the Ministry's answer/error. Saves nothing.
import * as cheerio from 'cheerio';
import { sendError, ApiError } from '../../http/errors.js';
import { requireConfig } from '../../config.js';
import { requireAdmin } from '../../http/admin.js';
import { withLock } from '../../store/locks.js';
import { assertActorActive, openActorSession, resolveActorId, sessionKey } from '../../silogtran/userSession.js';
import { parseRndc } from '../../silogtran/grabar.js';
import { formFields } from '../../silogtran/client.js';

const tidy = (t, n = 400) => String(t ?? '').replace(/[\u0000-\u001f ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export function inspectManifest(html) {
  const $ = cheerio.load(String(html));
  $('script, style').remove();
  const numero = tidy($('#ctl0_MainModule_manifiesto_numero').text(), 200);
  const mensajes = $('[id]').toArray()
    .filter((el) => !/^(input|button|select|textarea|option|script|style|form|body|html)$/i.test(el.tagName))
    .filter((el) => /rndc|ministerio|mensaje|respuesta|error/i.test(el.attribs.id))
    .map((el) => ({ id: el.attribs.id, text: tidy($(el).text()) }))
    .filter((x) => x.text)
    .slice(0, 15);
  const botones = $('input[type=submit], input[type=button], button').toArray()
    .filter((el) => /ministerio|rndc|enviar|reenv|transmit/i.test(`${el.attribs.id ?? ''} ${el.attribs.name ?? ''} ${el.attribs.value ?? ''}`))
    .map((el) => ({ id: el.attribs.id ?? el.attribs.name ?? null, value: tidy(el.attribs.value, 60) || null, disabled: el.attribs.disabled !== undefined }))
    .slice(0, 15);
  // Anything that looks like printing / a PDF: links, buttons, onclick handlers and report URLs written in scripts.
  const raw = cheerio.load(String(html));
  const imprimir = raw('a, input[type=submit], input[type=button], button').toArray()
    .filter((el) => /imprimir|pdf|reporte|print|descargar/i.test(`${el.attribs.id ?? ''} ${el.attribs.name ?? ''} ${el.attribs.value ?? ''} ${el.attribs.href ?? ''} ${el.attribs.onclick ?? ''} ${raw(el).text()}`))
    .map((el) => ({ tag: el.tagName, id: el.attribs.id ?? el.attribs.name ?? null, texto: tidy(raw(el).text() || el.attribs.value, 50) || null, href: tidy(el.attribs.href, 160) || null, onclick: tidy(el.attribs.onclick, 160) || null }))
    .slice(0, 15);
  const urlsPdf = [...new Set([...String(html).matchAll(/[^\s"'()<>]*(?:reportes\/|\.pdf)[^\s"'()<>]*/gi)].map((m) => tidy(m[0], 200)))].slice(0, 10);
  return { numero, rndc: parseRndc(String(html)), mensajes, botones, imprimir, urlsPdf };
}

// OPT-IN, only when the admin asks for it by name: presses ONE print button (a plain postback, like the browser) and reports what came back
// (status, final URL, content type, report URLs, window.open snippets). Never follows or stores the PDF; prints can leave a trace in Silogtran.
export async function pressPrint(client, manifiesto, label) {
  const url = `index.php?page=Despacho.Manifiesto_003.Home_111&manifiesto_codigo=${encodeURIComponent(manifiesto)}`;
  const page = await client.request(url);
  const $ = cheerio.load(page.text);
  const want = String(label).toLowerCase().replace(/\s+/g, '');
  const btn = $('input[type=submit], input[type=button], button').toArray()
    .find((el) => String(el.attribs.value ?? $(el).text()).toLowerCase().replace(/\s+/g, '') === want);
  if (!btn?.attribs.name) throw new ApiError('PRINT_BUTTON_NOT_FOUND', 'No se encontró ese botón de impresión en el manifiesto.', { status: 404 });
  const { form, data } = formFields(page.text);
  const action = new URL(form.attr('action') || page.url, page.url).href;
  // Same as the browser capture: a plain submit (empty PRADO_POSTBACK_TARGET/PARAMETER), the button name=value and every IDLockHidden_* = true.
  const form2 = { ...data, PRADO_POSTBACK_TARGET: '', PRADO_POSTBACK_PARAMETER: '', [btn.attribs.name]: btn.attribs.value ?? '' };
  for (const k of Object.keys(form2)) if (/IDLockHidden_/.test(k)) form2[k] = 'true';
  const res = await client.request(action, { method: 'POST', form: form2 });
  const isText = /text|json|xml|javascript/i.test(res.type);
  const text = isText ? res.text : '';
  return {
    boton: { id: btn.attribs.id ?? null, name: btn.attribs.name },
    status: res.status, urlFinal: res.url.replace(/Hash=[^&]+/i, 'Hash=…'), type: res.type, bytes: res.body.length,
    contentDisposition: res.headers.get('content-disposition'),
    reportUrls: [...new Set([...text.matchAll(/[^\s"'()<>\\]*(?:reportes\/|\.pdf)[^\s"'()<>\\]*/gi)].map((m) => tidy(m[0], 220)))].slice(0, 10),
    windowOpen: [...text.matchAll(/(?:window\.open|location\.href|\.location)[^;\n]{0,200}/gi)].map((m) => tidy(m[0], 220)).slice(0, 8),
    htmlTitle: isText ? tidy(cheerio.load(text)('title, h2').first().text(), 120) : null,
    inicio: isText && !/<form/i.test(text) ? tidy(text, 300) : null,
  };
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  try {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' });
    }
    requireAdmin(req);
    requireConfig();
    const manifiesto = String(req.body?.manifiesto ?? '').trim();
    if (!/^\d{4,15}$/.test(manifiesto)) throw new ApiError('INVALID_PARAMETER', 'Manifiesto inválido (solo dígitos).', { status: 400 });
    const userId = await resolveActorId(req.body?.usuario);
    await assertActorActive(userId);
    const out = await withLock(sessionKey(userId), async () => {
      const { client } = await openActorSession(userId);
      const page = await client.enqueue(() => client.request(`index.php?page=Despacho.Manifiesto_003.Home_111&manifiesto_codigo=${encodeURIComponent(manifiesto)}`));
      const insp = inspectManifest(page.text);
      // `imprimir` must be the exact button label and is the admin's explicit go-ahead to press it once.
      const label = String(req.body?.imprimir ?? '').trim();
      if (label) insp.pulsado = await client.enqueue(() => pressPrint(client, manifiesto, label));
      return insp;
    });
    res.status(200).json({ ok: true, manifiesto, ...out });
  } catch (e) {
    sendError(res, e);
  }
}
