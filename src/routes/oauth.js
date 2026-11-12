// OAuth 2.1 endpoints for the MCP (authorization code + PKCE S256, public clients, dynamic registration). One module, dispatched from api/oauth/[action].js.
import { ApiError, sendError } from '../http/errors.js';
import { requireEnv } from '../config.js';
import { baseUrl, authorizeSecret, registerClient, readClient, makeCode, exchange } from '../mcp/auth.js';

const cors = (res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
};
const json = (res, status, body) => { res.setHeader('cache-control', 'no-store'); res.setHeader('pragma', 'no-cache'); return res.status(status).json(body); };
const preflight = (req, res) => (req.method === 'OPTIONS' ? (cors(res), res.status(204).end(), true) : false);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function metadata(req, res) {
  cors(res);
  if (preflight(req, res)) return;
  const b = baseUrl(req);
  res.setHeader('cache-control', 'public, max-age=300');
  res.status(200).json({
    issuer: b, authorization_endpoint: `${b}/api/oauth/authorize`, token_endpoint: `${b}/api/oauth/token`, registration_endpoint: `${b}/api/oauth/register`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['mcp'],
  });
}

export function resource(req, res) {
  cors(res);
  if (preflight(req, res)) return;
  const b = baseUrl(req);
  res.setHeader('cache-control', 'public, max-age=300');
  const dispatch = /(^|\/)api\/mcp-despacho\/?$/.test(String(req.query?.path ?? ''));
  res.status(200).json({ resource: `${b}${dispatch ? '/api/mcp-despacho' : '/api/mcp'}`, authorization_servers: [b], bearer_methods_supported: ['header'], scopes_supported: ['mcp'], resource_name: dispatch ? 'Silogtran: despacho' : 'Silogtran: activación de vehículos' });
}

export function register(req, res) {
  cors(res);
  if (preflight(req, res)) return;
  try {
    requireEnv('TOKEN_SECRET');
    if (req.method !== 'POST') return json(res, 405, { error: 'invalid_request' });
    const out = registerClient(req.body);
    return json(res, out.error ? 400 : 201, out);
  } catch (e) { return sendError(res, e); }
}

const page = (res, status, inner) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.status(status).send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Autorizar acceso</title>
<style>body{font-family:system-ui,sans-serif;background:#f6f7f9;margin:0;padding:24px}main{max-width:420px;margin:8vh auto;background:#fff;border:1px solid #dde1e6;border-radius:10px;padding:24px}
h1{font-size:20px;margin:0 0 12px}p{color:#444;line-height:1.45}input[type=password]{width:100%;box-sizing:border-box;padding:10px;font-size:16px;margin:8px 0 14px}button{padding:10px 16px;font-size:16px;cursor:pointer}.err{color:#a33}</style></head><body><main>${inner}</main></body></html>`);
};

const FIELDS = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state'];

export async function authorize(req, res) {
  try {
    requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'TOKEN_SECRET');
    const p = req.method === 'POST' ? (req.body ?? {}) : (req.query ?? {});
    const client = readClient(p.client_id);
    // Bad client or redirect: never redirect, just show the error.
    if (!client || !client.ru.includes(String(p.redirect_uri))) return page(res, 400, '<h1>Solicitud inválida</h1><p>El cliente o la dirección de retorno no son válidos. Vuelve a conectar desde tu aplicación.</p>');
    if (p.response_type !== 'code' || p.code_challenge_method !== 'S256' || !p.code_challenge) return page(res, 400, '<h1>Solicitud inválida</h1><p>Falta PKCE (S256).</p>');
    const hidden = FIELDS.map((f) => `<input type="hidden" name="${f}" value="${esc(p[f])}">`).join('');
    const form = (msg) => `<h1>Autorizar acceso</h1><p><b>${esc(client.name)}</b> pide permiso para usar <b>herramientas de Silogtran con tu usuario</b>. Escribe tu <b>ticket de acceso</b> (lo generas en la página <b>/mcp</b> o <b>/mcp-despacho</b>, según el conector, después de entrar con tu link) para continuar.</p>${msg ? `<p class="err">${esc(msg)}</p>` : ''}<form method="post" action="/api/oauth/authorize">${hidden}<input type="password" name="key" autocomplete="off" placeholder="Ticket de acceso" aria-label="Ticket de acceso" required autofocus><button type="submit">Autorizar</button></form>`;
    if (req.method !== 'POST') return page(res, 200, form());
    let bind;
    try { bind = await authorizeSecret(req, p.key, client.name); } catch (e) { if (e instanceof ApiError && [403, 409, 429].includes(e.status)) return page(res, e.status, form(e.message)); throw e; }
    if (!bind) return page(res, 401, form('Ticket incorrecto, vencido o ya usado.'));
    const url = new URL(String(p.redirect_uri));
    url.searchParams.set('code', makeCode({ cid: p.client_id, ru: String(p.redirect_uri), cc: String(p.code_challenge), bind }));
    if (p.state) url.searchParams.set('state', String(p.state));
    res.setHeader('cache-control', 'no-store');
    return res.redirect(302, url.toString());
  } catch (e) { return sendError(res, e); }
}

export async function token(req, res) {
  cors(res);
  if (preflight(req, res)) return;
  try {
    requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'TOKEN_SECRET');
    if (req.method !== 'POST') return json(res, 405, { error: 'invalid_request' });
    const out = await exchange(req.body ?? {});
    return out.error ? json(res, out.error === 'invalid_client' ? 401 : 400, out) : json(res, 200, out.tokens);
  } catch (e) { return sendError(res, e); }
}
