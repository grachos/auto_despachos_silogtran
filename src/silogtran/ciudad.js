// City master (Basicos.Ciudad.Home&ciudad_codigo=<id>): the city's DANE/DIVIPOLA code (8 digits) lives in ctl0$MainModule$ciudad_codigodane.
// Business rule (owner, 2026-11-23): a trip is URBANO/MUNICIPAL when the first 5 digits (the municipality) of the origin and destination
// DANE codes are equal — e.g. DON DIEGO 47001003 and SANTA MARTA 47001000 are both municipality 47001.
import * as cheerio from 'cheerio';

export const cityPage = (id) => `index.php?page=Basicos.Ciudad.Home&ciudad_codigo=${encodeURIComponent(id)}`;

export function parseCityDane(html) {
  const v = String(cheerio.load(html)('input[name="ctl0$MainModule$ciudad_codigodane"]').attr('value') ?? '').trim();
  return /^\d{8}$/.test(v) ? v : null;
}

// true / false when both codes are valid; null when unknown (the caller keeps the by-name rule).
export function sameMunicipality(daneA, daneB) {
  if (!/^\d{8}$/.test(String(daneA ?? '')) || !/^\d{8}$/.test(String(daneB ?? ''))) return null;
  return String(daneA).slice(0, 5) === String(daneB).slice(0, 5);
}

export async function readCityDane(client, id) {
  if (!/^\d{1,10}$/.test(String(id ?? ''))) return null;
  const res = await client.request(cityPage(id));
  return parseCityDane(res.text);
}
