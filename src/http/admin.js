// Admin access: either the ADMIN_KEY in the x-api-key header (CLI/scripts) or a short-lived HttpOnly cookie
// obtained by POST /api/admin/login. The key itself is never kept in the browser.
import { timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors.js';
import { signToken, verifyToken } from '../token.js';
import { supabase } from '../store/supabase.js';

const COOKIE = 'adm';
const TTL_SEC = 8 * 3600;
const MAX_FAILED = 10; // per IP per 15 minutes

const eq = (a, b) => {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
};

export const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown').split(',')[0].trim();

export function setAdminCookie(res) {
  const token = signToken({ admin: true }, TTL_SEC, 'admin');
  res.setHeader('set-cookie', `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/api/admin; Max-Age=${TTL_SEC}`);
}
export const clearAdminCookie = (res) => res.setHeader('set-cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/api/admin; Max-Age=0`);

function cookieValid(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || '');
  if (!m) return false;
  try {
    return verifyToken(m[1], 'admin').admin === true;
  } catch {
    return false;
  }
}

// State-changing requests authenticated by cookie must come from our own origin (CSRF defence in depth).
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers['x-forwarded-host'] || req.headers.host);
  } catch {
    return false;
  }
}

export function requireAdmin(req) {
  if (!process.env.ADMIN_KEY) throw new ApiError('CONFIG_MISSING', 'Falta configurar ADMIN_KEY en el servidor.', { status: 500 });
  if (req.headers['x-api-key'] && eq(req.headers['x-api-key'], process.env.ADMIN_KEY)) return;
  if (cookieValid(req)) {
    if (req.method !== 'GET' && !sameOrigin(req)) throw new ApiError('FORBIDDEN_ORIGIN', 'Origen no permitido.', { status: 403 });
    return;
  }
  throw new ApiError('ADMIN_REQUIRED', 'Necesitas iniciar sesión como administrador.', { status: 401 });
}

// Login with the admin key; failed attempts are rate limited per IP.
export async function adminLogin(req, key) {
  if (!process.env.ADMIN_KEY) throw new ApiError('CONFIG_MISSING', 'Falta configurar ADMIN_KEY en el servidor.', { status: 500 });
  const db = supabase();
  const ip = clientIp(req);
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const { data, error } = await db.from('admin_intentos').select('id').eq('ip', ip).gt('created_at', since);
  if (error) throw new ApiError('STORE_FAILED', 'No se pudo verificar el acceso.', { status: 500, detail: error.message });
  if (data.length >= MAX_FAILED) throw new ApiError('ADMIN_LOCKED', 'Demasiados intentos fallidos; espera 15 minutos.', { status: 429 });
  if (!eq(key, process.env.ADMIN_KEY)) {
    await db.from('admin_intentos').insert({ ip });
    await new Promise((r) => setTimeout(r, 400));
    throw new ApiError('ADMIN_LOGIN_FAILED', 'Clave de administrador incorrecta.', { status: 401 });
  }
}
