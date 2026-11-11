// Access control of the MCP endpoint. Two kinds of principal:
//   - { kind: 'user', uid, scope, mc }: a PERSON, connected with a one-time ticket that became a revocable connection (src/store/mcp.js).
//     Every call re-checks the connection in the database, so revoking is immediate. Tools run with THAT person's Silogtran session,
//     so Silogtran itself records who did the action.
//   - { kind: 'admin' }: the owner's MCP_KEY (optional env var; Bearer for Claude Code/curl, or typed on the authorize page). Acts as user zero.
// OAuth tokens (access 1 h, refresh 30 days, code 5 min) are stateless HMAC tokens (TOKEN_SECRET) bound to a person+connection or to the admin key.
import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../http/errors.js';
import { signToken, verifyToken } from '../token.js';
import { clientIp } from '../http/admin.js';
import { supabase } from '../store/supabase.js';
import * as mcpStore from '../store/mcp.js';

const eq = (a, b) => {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
};

// The admin key is optional: without it only people with tickets can connect.
const adminKey = () => (process.env.MCP_KEY && process.env.MCP_KEY.length >= 24 ? process.env.MCP_KEY : null);
export const keyFingerprint = () => (adminKey() ? createHash('sha256').update(adminKey()).digest('hex').slice(0, 12) : null);
export const baseUrl = (req) => `https://${req.headers['x-forwarded-host'] || req.headers.host}`;

export const TTL = { access: 3600, refresh: 30 * 86400, code: 300, client: 365 * 86400 };

export const authDeps = { checkConnection: mcpStore.checkConnection, redeemTicket: mcpStore.redeemTicket };

// Request -> principal or null.
export async function authenticate(req, deps = authDeps) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
  if (!m) return null;
  if (adminKey() && eq(m[1], adminKey())) return { kind: 'admin' };
  try {
    const p = verifyToken(m[1], 'mcp-access');
    return await principalOf(p, deps);
  } catch {
    return null;
  }
}

async function principalOf(p, deps) {
  if (p.adm) return adminKey() && p.kv === keyFingerprint() ? { kind: 'admin' } : null;
  return (await deps.checkConnection(p.mc, p.uid, p.sc)) ? { kind: 'user', uid: p.uid, scope: p.sc, mc: p.mc } : null;
}

// Failed attempts on the authorize page are limited per IP (shares the admin lockout table: 10 per 15 minutes).
const defaultStore = {
  async count(ip, since) {
    const { data, error } = await supabase().from('admin_intentos').select('id').eq('ip', ip).gt('created_at', since);
    if (error) throw new ApiError('STORE_FAILED', 'No se pudo verificar el acceso.', { status: 500, detail: error.message });
    return data.length;
  },
  async add(ip) { await supabase().from('admin_intentos').insert({ ip }); },
};

// Text typed on the authorize page: the admin key, or a ticket. Returns the binding for the OAuth code, or null if it is wrong.
export async function authorizeSecret(req, raw, label, deps = authDeps, store = defaultStore, delayMs = 400) {
  const ip = clientIp(req);
  if ((await store.count(ip, new Date(Date.now() - 15 * 60_000).toISOString())) >= 10) throw new ApiError('ADMIN_LOCKED', 'Demasiados intentos fallidos; espera 15 minutos.', { status: 429 });
  const typed = String(raw ?? '').trim();
  if (adminKey() && eq(typed, adminKey())) return { adm: true, kv: keyFingerprint() };
  const redeemed = typed ? await deps.redeemTicket(typed, label) : null;
  if (redeemed) return { uid: redeemed.uid, sc: redeemed.sc, mc: redeemed.mc };
  await store.add(ip);
  await new Promise((r) => setTimeout(r, delayMs));
  return null;
}

// ---- OAuth 2.1 pieces (stateless) ----
const REDIRECT_OK = (u) => {
  try {
    const x = new URL(u);
    return (x.protocol === 'https:' || (x.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(x.hostname))) && !x.hash;
  } catch { return false; }
};

export function registerClient(body) {
  const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > 5 || !uris.every(REDIRECT_OK)) return { error: 'invalid_redirect_uri', error_description: 'redirect_uris debe traer de 1 a 5 URLs https (o http://localhost).' };
  const name = String(body?.client_name ?? 'Cliente MCP').replace(/[\u0000-\u001f]/g, ' ').slice(0, 60);
  const client_id = signToken({ ru: uris, name }, TTL.client, 'mcp-client');
  return { client_id, client_name: name, redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'mcp' };
}

export function readClient(clientId) {
  try { return verifyToken(clientId, 'mcp-client'); } catch { return null; }
}

export const challengeOf = (verifier) => createHash('sha256').update(String(verifier)).digest('base64url');

export const makeCode = ({ cid, ru, cc, bind }) => signToken({ cid, ru, cc, bind }, TTL.code, 'mcp-code');

function issueTokens(cid, bind) {
  return {
    access_token: signToken({ cid, ...bind }, TTL.access, 'mcp-access'),
    token_type: 'Bearer', expires_in: TTL.access, scope: 'mcp',
    refresh_token: signToken({ cid, ...bind }, TTL.refresh, 'mcp-refresh'),
  };
}
const bindOf = (p) => (p.adm ? { adm: true, kv: p.kv } : { uid: p.uid, sc: p.sc, mc: p.mc });

// grant_type authorization_code | refresh_token -> { tokens } or { error }
export async function exchange(params, deps = authDeps) {
  const bad = (error, error_description) => ({ error, error_description });
  if (!readClient(params.client_id)) return bad('invalid_client', 'client_id desconocido o vencido.');
  try {
    if (params.grant_type === 'authorization_code') {
      const code = verifyToken(params.code, 'mcp-code');
      if (code.cid !== params.client_id || code.ru !== params.redirect_uri) return bad('invalid_grant', 'El código no corresponde a este cliente o redirección.');
      if (!params.code_verifier || challengeOf(params.code_verifier) !== code.cc) return bad('invalid_grant', 'PKCE inválido.');
      return { tokens: issueTokens(params.client_id, code.bind) };
    }
    if (params.grant_type === 'refresh_token') {
      const r = verifyToken(params.refresh_token, 'mcp-refresh');
      if (r.cid !== params.client_id) return bad('invalid_grant', 'Refresh token inválido.');
      if (!(await principalOf(r, deps))) return bad('invalid_grant', 'El acceso fue revocado o venció; conecta de nuevo.');
      return { tokens: issueTokens(params.client_id, bindOf(r)) };
    }
  } catch {
    return bad('invalid_grant', 'Código o token inválido o vencido.');
  }
  return bad('unsupported_grant_type', 'Solo authorization_code y refresh_token.');
}
