// MCP endpoint (Streamable HTTP, stateless). Auth: an OAuth access token of a connected person, or the admin MCP_KEY (see src/mcp/auth.js).
import { sendError } from '../src/http/errors.js';
import { requireEnv } from '../src/config.js';
import { authenticate, baseUrl } from '../src/mcp/auth.js';
import { handleBody } from '../src/mcp/server.js';

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version, mcp-session-id');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'TOKEN_SECRET');
    // /api/mcp = activation server; /api/mcp-despacho (rewrite -> ?srv=despacho) = dispatch server. Each only serves its own scope.
    const srv = req.query?.srv === 'despacho' ? 'despachar' : 'activar';
    const principal = await authenticate(req);
    if (!principal) {
      const meta = srv === 'despachar' ? '/.well-known/oauth-protected-resource/api/mcp-despacho' : '/.well-known/oauth-protected-resource';
      res.setHeader('www-authenticate', `Bearer resource_metadata="${baseUrl(req)}${meta}"`);
      return res.status(401).json({ error: 'unauthorized', error_description: 'Falta o es inválido el token de acceso.' });
    }
    if (srv === 'despachar' ? principal.kind !== 'user' || principal.scope !== 'despachar' : principal.kind === 'user' && principal.scope !== 'activar') {
      return res.status(403).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Este acceso no corresponde a este conector. Genera un ticket del tipo correcto en la página de tu link.' } });
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return res.status(405).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Usa POST (servidor sin estado).' } });
    }
    const out = await handleBody(req.body, undefined, principal, srv);
    if (out.body === null) return res.status(out.status).end();
    return res.status(out.status).json(out.body);
  } catch (e) {
    return sendError(res, e);
  }
}
