// Does this plate exist in Silogtran's vehicle master? Replays the master search (Maestros.Vehiculo.Buscar): a plate that exists sends the
// browser straight to its record (…Maestros.Vehiculo.Home_111&vehiculo_codigo=N); a plate that does not exist leaves the person on the
// search screen with no result. Read-only. Returns true | false | null (null = could not tell: callers must NOT block on it).
import * as cheerio from 'cheerio';
import { formFields } from './client.js';
import { norm } from './text.js';

const BUSCAR = 'index.php?page=Maestros.Vehiculo.Buscar';
const P = 'ctl0$MainModule$';

// Decision from the search answer alone (pure, unit-tested).
export function plateSearchVerdict(url, html) {
  if (/Maestros\.Vehiculo\.Home/.test(String(url)) && /vehiculo_codigo=\d+/.test(String(url))) return true; // went straight to the record
  const $ = cheerio.load(String(html));
  if ($('a[href*="Maestros.Vehiculo.Home"][href*="vehiculo_codigo="]').length) return true; // a result list that links to records
  const title = norm($('h2').first().text());
  if (title.includes('busqueda') && title.includes('vehiculo')) return false; // still on the search form, nothing found
  return null;
}

export async function plateExists(client, placa) {
  const plate = String(placa ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,10}$/.test(plate)) return null;
  const page = await client.request(BUSCAR);
  const { form, data } = formFields(page.text);
  const field = `${P}vehiculo_placa`;
  if (!(field in data)) return null;
  const res = await client.request(new URL(form.attr('action') || page.url, page.url).href, {
    method: 'POST',
    form: { ...data, [field]: plate, PRADO_POSTBACK_TARGET: `${P}ctl3`, PRADO_POSTBACK_PARAMETER: 'undefined', [`${P}IDLockHidden_ctl0_MainModule_ctl3`]: 'true' },
  });
  return plateSearchVerdict(res.url, res.text);
}
