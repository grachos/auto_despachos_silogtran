// Serverless session: restore cookies from Supabase, validate, re-login only when needed,
// and persist the (possibly refreshed) cookie jar back.
import { Silogtran } from './client.js';
import { DEFAULT_USER_ID, loadCookies, saveCookies } from '../store/sessionStore.js';

const DEFAULT_BASE_URL = 'https://construproyec.colombiasoftware.net';

// userId/credentials default to the env-configured "user zero"; per-user credentials
// (decrypted by the caller, never logged) will be passed in once multi-user lands.
export async function openSession({
  userId = DEFAULT_USER_ID,
  user = process.env.SILOG_USER,
  password = process.env.SILOG_PASSWORD,
} = {}) {
  const client = new Silogtran(process.env.SILOG_BASE_URL || DEFAULT_BASE_URL);
  const stored = await loadCookies(userId);
  let reused = false;
  if (stored) {
    client.importCookies(stored);
    reused = await client.isLoggedIn();
  }
  if (!reused) await client.login(user, password);
  await saveCookies(client.exportCookies(), userId);
  return { client, reused };
}
