// Access control of the MCP endpoint. Two ways in:
//   1. `Authorization: Bearer <MCP_KEY>` (Claude Code, MCP Inspector, curl);
//   2. an OAuth access token (typ "mcp-access") issued by /api/oauth/token after the owner typed MCP_KEY on the authorize page
//      (what claude.ai, Claude Desktop/mobile and ChatGPT use). Tokens are stateless (HMAC with TOKEN_SECRET) and carry a fingerprint of
//      MCP_KEY, so rotating MCP_KEY revokes every issued token at once.
import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../http/errors.js';
import { signToken, verifyToken } from '../token.js';
import { clientIp } from '../http/admin.js';
import { supabase } from '../store/supabase.js';

const eq = (a, b) => {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
};

export function mcpKey() {
  const k = process.env.MCP_KEY;
  if (!k || k.length < 24) throw new ApiError('CONFIG_MISSING', 'Falta configurar MCP_KEY (mínimo 24 caracteres) en el servidor.', { status: 500 });
  return k;
}
export const keyFingerprint = () => createHash('sha256').update(mcpKey()).digest('hex').slice(0, 12);
export const baseUrl = (req) => `https://${req.headers['x-forwarded-host'] || req.headers.host}`;

export const TTL = { access: 3600, refresh: 30 * 86400, code: 300, client: 365 * 86400 };

export function bearerOk(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
  if (!m) return false;
  if (eq(m[1], mcpKey())) return true;
  try {
    return verifyToken(m[1], 'mcp-access').kv === keyFingerprint();
  } catch {
    return false;
  }
}

// Typing the key on the authorize page: failed attempts are limited per IP (shares the admin lockout table: 10 per 15 minutes).
const defaultStore = {
  async count(ip, since) {
    const { data, error } = await supabase().from('admin_intentos').select('id').eq('ip', ip).gt('created_at', since);
    if (error) throw new ApiError('STORE_FAILED', 'No se pudo verificar el acceso.', { status: 500, detail: error.message });
    return data.length;
  },
  async add(ip) { await supabase().from('admin_intentos').insert({ ip }); },
};
export async function accessKeyOk(req, key, store = defaultStore, delayMs = 400) {
  const ip = clientIp(req);
  if ((await store.count(ip, new Date(Date.now() - 15 * 60_000).toISOString())) >= 10) throw new ApiError('ADMIN_LOCKED', 'Demasiados intentos fallidos; espera 15 minutos.', { status: 429 });
  if (eq(key, mcpKey())) return true;
  await store.add(ip);
  await new Promise((r) => setTimeout(r, delayMs));
  return false;
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
  const client_id = signToken({ ru: uris, name, kv: keyFingerprint() }, TTL.client, 'mcp-client');
  return { client_id, client_name: name, redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'mcp' };
}

export function readClient(clientId) {
  try {
    const c = verifyToken(clientId, 'mcp-client');
    return c.kv === keyFingerprint() ? c : null;
  } catch { return null; }
}

export const challengeOf = (verifier) => createHash('sha256').update(String(verifier)).digest('base64url');

export const makeCode = ({ cid, ru, cc }) => signToken({ cid, ru, cc, kv: keyFingerprint() }, TTL.code, 'mcp-code');

function issueTokens(cid) {
  const kv = keyFingerprint();
  return {
    access_token: signToken({ cid, kv }, TTL.access, 'mcp-access'),
    token_type: 'Bearer', expires_in: TTL.access, scope: 'mcp',
    refresh_token: signToken({ cid, kv }, TTL.refresh, 'mcp-refresh'),
  };
}

// grant_type authorization_code | refresh_token -> { tokens } or { error }
export function exchange(params) {
  const bad = (error, error_description) => ({ error, error_description });
  const client = readClient(params.client_id);
  if (!client) return bad('invalid_client', 'client_id desconocido o vencido.');
  try {
    if (params.grant_type === 'authorization_code') {
      const code = verifyToken(params.code, 'mcp-code');
      if (code.kv !== keyFingerprint() || code.cid !== params.client_id || code.ru !== params.redirect_uri) return bad('invalid_grant', 'El código no corresponde a este cliente o redirección.');
      if (!params.code_verifier || challengeOf(params.code_verifier) !== code.cc) return bad('invalid_grant', 'PKCE inválido.');
      return { tokens: issueTokens(params.client_id) };
    }
    if (params.grant_type === 'refresh_token') {
      const r = verifyToken(params.refresh_token, 'mcp-refresh');
      if (r.kv !== keyFingerprint() || r.cid !== params.client_id) return bad('invalid_grant', 'Refresh token inválido.');
      return { tokens: issueTokens(params.client_id) };
    }
  } catch {
    return bad('invalid_grant', 'Código o token inválido o vencido.');
  }
  return bad('unsupported_grant_type', 'Solo authorization_code y refresh_token.');
}
