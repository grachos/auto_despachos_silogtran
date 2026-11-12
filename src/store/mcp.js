// MCP access per person: scopes granted by the administrator, one-time tickets (stored only as HMAC) and revocable connections.
import { createHmac, randomInt } from 'node:crypto';
import { supabase } from './supabase.js';
import { ApiError } from '../http/errors.js';
import { getUser } from './usuarios.js';

export const SCOPES = ['activar', 'despachar'];
// Connector URL of each scope (the dispatch connector is a separate server so a person with only activations never sees dispatch tools).
export const CONNECTOR_PATH = { activar: '/api/mcp', despachar: '/api/mcp-despacho' };
export const TICKET_TTL_MS = 15 * 60 * 1000;
export const MAX_TICKETS_PER_HOUR = 5;
export const MAX_CONNECTIONS = 3; // per person and scope (Claude + ChatGPT + phone)
export const INACTIVITY_MS = 90 * 86400_000;
const TOUCH_EVERY_MS = 5 * 60_000;

const fail = (e) => new ApiError('STORE_FAILED', 'No se pudo leer o guardar en Supabase.', { status: 500, detail: e?.message || String(e) });
const run = async (q) => {
  const { data, error } = await q;
  if (error) throw Object.assign(fail(error), { pgCode: error.code });
  return data;
};

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alikes (0/O, 1/I/L)
export const newTicket = () => Array.from({ length: 16 }, () => ALPHABET[randomInt(0, ALPHABET.length)]).join('').replace(/(.{4})(?=.)/g, '$1-');
export const normalizeTicket = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const ticketHash = (raw) => createHmac('sha256', process.env.TOKEN_SECRET || '').update(`mcp-ticket:${normalizeTicket(raw)}`).digest('hex');

export const getScopes = async (userId) => (await run(supabase().from('mcp_permisos').select('scope').eq('user_id', userId))).map((r) => r.scope);

export async function setScope(userId, scope, enabled) {
  if (!SCOPES.includes(scope)) throw new ApiError('INVALID_PARAMETER', 'Alcance inválido.', { status: 400 });
  const db = supabase();
  if (enabled) {
    await run(db.from('mcp_permisos').upsert({ user_id: userId, scope }, { onConflict: 'user_id,scope' }));
  } else {
    await run(db.from('mcp_permisos').delete().eq('user_id', userId).eq('scope', scope));
    // taking the permission away also cuts the live connections and pending tickets of that scope
    const now = new Date().toISOString();
    await run(db.from('mcp_conexiones').update({ revoked_at: now }).eq('user_id', userId).eq('scope', scope).is('revoked_at', null));
    await run(db.from('mcp_tickets').update({ expires_at: now }).eq('user_id', userId).eq('scope', scope).is('used_at', null));
  }
}

const activeConnections = (userId, scope) => supabase().from('mcp_conexiones').select('id').eq('user_id', userId).eq('scope', scope).is('revoked_at', null);

// New ticket for a person that has the scope; revokes their previous unused ones. Rate limited.
export async function createTicket(userId, scope) {
  if (!(await getScopes(userId)).includes(scope)) throw new ApiError('MCP_NOT_ENABLED', 'El administrador aún no te habilitó este acceso.', { status: 403 });
  const db = supabase();
  const recent = await run(db.from('mcp_tickets').select('id').eq('user_id', userId).gt('created_at', new Date(Date.now() - 3600_000).toISOString()));
  if (recent.length >= MAX_TICKETS_PER_HOUR) throw new ApiError('TICKET_RATE_LIMIT', 'Generaste demasiados tickets en la última hora; espera un momento.', { status: 429 });
  if ((await run(activeConnections(userId, scope))).length >= MAX_CONNECTIONS) {
    throw new ApiError('MCP_CONNECTION_LIMIT', `Ya tienes ${MAX_CONNECTIONS} conexiones activas; revoca una para conectar otra.`, { status: 409 });
  }
  const nowIso = new Date().toISOString();
  await run(db.from('mcp_tickets').update({ expires_at: nowIso }).eq('user_id', userId).is('used_at', null).gt('expires_at', nowIso));
  const expiresAt = new Date(Date.now() + TICKET_TTL_MS).toISOString();
  for (let i = 0; i < 5; i++) {
    const ticket = newTicket();
    try {
      await run(db.from('mcp_tickets').insert({ user_id: userId, scope, token_hash: ticketHash(ticket), expires_at: expiresAt }));
      return { ticket, expiresAt };
    } catch (e) {
      if (e.pgCode !== '23505') throw e;
    }
  }
  throw new ApiError('TICKET_GENERATION_FAILED', 'No se pudo generar el ticket; intenta de nuevo.', { status: 500 });
}

// Spends a ticket (single use, atomic) and opens the connection. null = unknown/expired/used ticket.
export async function redeemTicket(raw, label) {
  const db = supabase();
  const t = await run(db.from('mcp_tickets').select('id, user_id, scope, expires_at, used_at').eq('token_hash', ticketHash(raw)).maybeSingle());
  if (!t || t.used_at || new Date(t.expires_at) <= new Date()) return null;
  const user = await getUser(t.user_id);
  if (!user || user.status !== 'ACTIVE') throw new ApiError('USER_NOT_ACTIVE', 'Tu usuario no está activo.', { status: 403 });
  if (!(await getScopes(t.user_id)).includes(t.scope)) throw new ApiError('MCP_NOT_ENABLED', 'El administrador retiró este acceso.', { status: 403 });
  if ((await run(activeConnections(t.user_id, t.scope))).length >= MAX_CONNECTIONS) throw new ApiError('MCP_CONNECTION_LIMIT', `Ya tienes ${MAX_CONNECTIONS} conexiones activas; revoca una en /mcp.`, { status: 409 });
  const used = await run(db.from('mcp_tickets').update({ used_at: new Date().toISOString() }).eq('id', t.id).is('used_at', null).select('id'));
  if (!used.length) return null;
  const conn = await run(db.from('mcp_conexiones').insert({ user_id: t.user_id, scope: t.scope, label: String(label ?? 'Cliente MCP').slice(0, 60) }).select('id').single());
  return { uid: t.user_id, sc: t.scope, mc: conn.id };
}

// Per-call check: connection alive (not revoked, used within 90 days), scope still granted, user ACTIVE. Touches last_used_at (throttled).
export async function checkConnection(mc, uid, sc) {
  if (!mc || !uid || !sc) return false;
  const db = supabase();
  const c = await run(db.from('mcp_conexiones').select('id, user_id, scope, created_at, last_used_at, revoked_at').eq('id', mc).maybeSingle());
  if (!c || c.revoked_at || c.user_id !== uid || c.scope !== sc) return false;
  const last = new Date(c.last_used_at ?? c.created_at).getTime();
  if (Date.now() - last > INACTIVITY_MS) {
    await run(db.from('mcp_conexiones').update({ revoked_at: new Date().toISOString() }).eq('id', mc).is('revoked_at', null));
    return false;
  }
  const user = await getUser(uid);
  if (!user || user.status !== 'ACTIVE') return false;
  if (!(await getScopes(uid)).includes(sc)) return false;
  if (Date.now() - last > TOUCH_EVERY_MS) await db.from('mcp_conexiones').update({ last_used_at: new Date().toISOString() }).eq('id', mc);
  return true;
}

export const listConnections = async (userId = null) => {
  let q = supabase().from('mcp_conexiones').select('id, user_id, scope, label, created_at, last_used_at, revoked_at').is('revoked_at', null).order('created_at', { ascending: false });
  if (userId) q = q.eq('user_id', userId);
  return run(q);
};

// Revokes a connection (the person may only revoke their own). Returns true if something was revoked.
export async function revokeConnection(id, userId = null) {
  let q = supabase().from('mcp_conexiones').update({ revoked_at: new Date().toISOString() }).eq('id', id).is('revoked_at', null);
  if (userId) q = q.eq('user_id', userId);
  return (await run(q.select('id'))).length > 0;
}

export const listAllPermisos = async () => run(supabase().from('mcp_permisos').select('user_id, scope'));
