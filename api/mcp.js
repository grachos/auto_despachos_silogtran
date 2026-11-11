// MCP endpoint (Streamable HTTP, stateless). Auth: Bearer MCP_KEY or an OAuth access token (see src/mcp/auth.js).
import { sendError } from '../src/http/errors.js';
import { requireEnv } from '../src/config.js';
import { bearerOk, baseUrl } from '../src/mcp/auth.js';
import { handleBody } from '../src/mcp/server.js';

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version, mcp-session-id');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'TOKEN_SECRET', 'MCP_KEY');
    if (!bearerOk(req)) {
      res.setHeader('www-authenticate', `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`);
      return res.status(401).json({ error: 'unauthorized', error_description: 'Falta o es inválido el token de acceso.' });
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return res.status(405).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Usa POST (servidor sin estado).' } });
    }
    const out = await handleBody(req.body);
    if (out.body === null) return res.status(out.status).end();
    return res.status(out.status).json(out.body);
  } catch (e) {
    return sendError(res, e);
  }
}
