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

// One search of the vehicle master; `estado` (19 ACTIVO, 20 INACTIVO, 21 ANULADO) is the search screen's state filter (optional).
async function searchPlate(client, plate, estado = null) {
  const page = await client.request(BUSCAR);
  const { form, data } = formFields(page.text);
  const field = `${P}vehiculo_placa`;
  if (!(field in data)) return null;
  const res = await client.request(new URL(form.attr('action') || page.url, page.url).href, {
    method: 'POST',
    form: { ...data, [field]: plate, ...(estado != null ? { [`${P}estado_codigo`]: String(estado) } : {}), PRADO_POSTBACK_TARGET: `${P}ctl3`, PRADO_POSTBACK_PARAMETER: 'undefined', [`${P}IDLockHidden_ctl0_MainModule_ctl3`]: 'true' },
  });
  return plateSearchVerdict(res.url, res.text);
}

const validPlate = (placa) => {
  const plate = String(placa ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{4,10}$/.test(plate) ? plate : null;
};

export async function plateExists(client, placa) {
  const plate = validPlate(placa);
  return plate ? searchPlate(client, plate) : null;
}

// 'missing' (no such plate) | 'inactive' (exists but its state is INACTIVO) | 'ok' | null (could not tell: never block).
// The record page has no state field; the search screen's state filter is the only signal (verified: an inactive plate is found with
// estado=20 and an active one is not). So: plain search first (proven); only if it exists, one more search filtered by INACTIVO.
export async function plateStatus(client, placa) {
  const plate = validPlate(placa);
  if (!plate) return null;
  const exists = await searchPlate(client, plate);
  if (exists !== true) return exists === false ? 'missing' : null;
  const inactive = await searchPlate(client, plate, 20);
  if (inactive === true) return 'inactive';
  return inactive === false ? 'ok' : null;
}
