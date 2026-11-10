// Manifest PDF: presses «Imprimir Ministerio 2026» on the manifest page (a plain form submit, exactly like the browser capture) and reads the
// public report link from the answer. The answer is an HTML page with one `window.open('../reportes/<site>/DOC_<hash>.pdf')` per generated
// document; the FIRST one is the manifest (confirmed by the owner; the second is a complement that is not useful here).
// Each press generates new files in Silogtran (same effect as printing by hand), so callers do it once per dispatch.
import * as cheerio from 'cheerio';
import { formFields } from './client.js';
import { ApiError } from '../http/errors.js';

export const PRINT_LABEL = 'Imprimir Ministerio 2026';
const manifestPage = (manifiesto) => `index.php?page=Despacho.Manifiesto_003.Home_111&manifiesto_codigo=${encodeURIComponent(manifiesto)}`;

// Presses the print button; returns the raw answer ({ status, url, type, body, headers, text }) and the button found.
export async function pressPrintButton(client, manifiesto, label = PRINT_LABEL, { timeoutSec } = {}) {
  const page = await client.request(manifestPage(manifiesto), { timeoutSec });
  const $ = cheerio.load(page.text);
  const want = String(label).toLowerCase().replace(/\s+/g, '');
  const btn = $('input[type=submit], input[type=button], button').toArray()
    .find((el) => String(el.attribs.value ?? $(el).text()).toLowerCase().replace(/\s+/g, '') === want);
  if (!btn?.attribs.name) throw new ApiError('PRINT_BUTTON_NOT_FOUND', 'No se encontró ese botón de impresión en el manifiesto.', { status: 404 });
  const { form, data } = formFields(page.text);
  const action = new URL(form.attr('action') || page.url, page.url).href;
  // Same as the browser capture: plain submit (empty PRADO_POSTBACK_TARGET/PARAMETER), the button name=value and every IDLockHidden_* = true.
  const body = { ...data, PRADO_POSTBACK_TARGET: '', PRADO_POSTBACK_PARAMETER: '', [btn.attribs.name]: btn.attribs.value ?? '' };
  for (const k of Object.keys(body)) if (/IDLockHidden_/.test(k)) body[k] = 'true';
  const res = await client.request(action, { method: 'POST', form: body, timeoutSec });
  return { res, btn: { id: btn.attribs.id ?? null, name: btn.attribs.name } };
}

// Absolute, validated report links in the order the page opens them. Only https links to a `/reportes/…/DOC_*.pdf` file on the SAME site
// as the page are accepted (whatever else the HTML contains is ignored).
export function parseReportUrls(html, pageUrl) {
  let base;
  try { base = new URL(pageUrl); } catch { return []; }
  const out = [];
  for (const m of String(html).matchAll(/window\.open\(\s*['"]([^'"]+\.pdf)['"]/gi)) {
    try {
      const u = new URL(m[1], base);
      if (u.origin === base.origin && u.protocol === 'https:' && /^\/reportes\/[^/]+\/DOC_[A-Za-z0-9]+\.pdf$/.test(u.pathname) && !out.includes(u.href)) out.push(u.href);
    } catch { /* ignore malformed link */ }
  }
  return out;
}

// Public link of the manifest PDF, or null if it could not be obtained (best effort: never throws).
export async function getManifestPdfUrl(client, manifiesto) {
  try {
    const { res } = await pressPrintButton(client, manifiesto, PRINT_LABEL, { timeoutSec: 15 });
    const urls = parseReportUrls(res.text, res.url);
    if (!urls.length) console.error('[pdf] no report link in the print answer');
    return urls[0] ?? null;
  } catch (e) {
    console.error('[pdf] manifest link skipped:', e?.code || e?.name || 'error');
    return null;
  }
}
