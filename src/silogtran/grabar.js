// Step 11-12: save (Generar), read the generated documents and the RNDC status.
import * as cheerio from 'cheerio';
import { ApiError } from '../http/errors.js';
import { norm } from './text.js';

const P = 'ctl0$MainModule$';
const SAVE_TIMEOUT_SEC = 50; // saving takes 10-18 s in Silogtran

export function parseSaveResult(html) {
  const $ = cheerio.load(html);
  const box = $('#ctl0_MainModule_mensaje');
  let text = box.text();
  if (!norm(text).includes('el registro ha sido guardado')) {
    text = $('[id*="ensaje"]').toArray().map((el) => $(el).text()).find((t) => norm(t).includes('el registro ha sido guardado')) ?? text;
  }
  const lines = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
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
  return { saved, warnings: rest ? [rest] : [], documents, rawMessage: lines.join(' | ') };
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

export function parseRndc(html) {
  const $ = cheerio.load(html);
  const text = $('#ctl0_MainModule_manifiesto_numero').text().replace(/ /g, ' ');
  if (!text.trim()) return null;
  const m = /^\s*(\d+)\s*-\s*(\d+)?/.exec(text);
  const f = /Fecha Hora\s*(\d{4}-\d{2}-\d{2})\s*\/\s*(\d{2}:\d{2}:\d{2})/.exec(text);
  const radicado = m?.[2] ?? null;
  return { migrated: Boolean(radicado), radicado, fechaHora: f ? `${f[1]} ${f[2]}` : null };
}

export async function readRndc(client, manifiesto) {
  const res = await client.request(`index.php?page=Despacho.Manifiesto_003.Home_111&manifiesto_codigo=${encodeURIComponent(manifiesto)}`);
  return parseRndc(res.text);
}
