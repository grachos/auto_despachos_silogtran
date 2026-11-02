// Serverless session: restore cookies from Supabase, validate, re-login only when needed,
// and persist the (possibly refreshed) cookie jar back.
import { Silogtran } from './client.js';
import { loadCookies, saveCookies } from '../store/sessionStore.js';

const DEFAULT_BASE_URL = 'https://construproyec.colombiasoftware.net';

export async function openSession() {
  const client = new Silogtran(process.env.SILOG_BASE_URL || DEFAULT_BASE_URL);
  const stored = await loadCookies();
  let reused = false;
  if (stored) {
    client.importCookies(stored);
    reused = await client.isLoggedIn();
  }
  if (!reused) await client.login(process.env.SILOG_USER, process.env.SILOG_PASSWORD);
  await saveCookies(client.exportCookies());
  return { client, reused };
}
