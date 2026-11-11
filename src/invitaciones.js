// Invitation flow: a single-use link (2 h) lets a person prove their Silogtran credentials once.
// Order matters: validate the link -> reserve an attempt (atomic) -> real Silogtran login ->
// consume the link (atomic) -> store encrypted credentials + session cookies.
import { createHash, randomBytes } from 'node:crypto';
import { ApiError } from './http/errors.js';
import { MAX_ATTEMPTS } from './store/usuarios.js';
import * as realStore from './store/usuarios.js';
import { Silogtran } from './silogtran/client.js';
import { loadCookies, saveCookies } from './store/sessionStore.js';
import { setScope } from './store/mcp.js';

export const hashToken = (raw) => createHash('sha256').update(String(raw)).digest('hex');
export const newRawToken = () => randomBytes(32).toString('base64url');

const DEFAULT_BASE_URL = 'https://construproyec.colombiasoftware.net';

// Real Silogtran login on a FRESH client (never touches user zero's stored session).
// AWS WAF cookies are borrowed from the default session to skip launching Chromium when possible.
async function realSilogLogin(usuario, clave) {
  const client = new Silogtran(process.env.SILOG_BASE_URL || DEFAULT_BASE_URL);
  const base = await loadCookies().catch(() => null);
  if (base) client.importCookies(Object.fromEntries(Object.entries(base).filter(([k]) => k.toLowerCase().startsWith('aws-waf'))));
  await client.login(usuario, clave);
  return { jar: client.exportCookies(), costCenter: client.costCenter };
}

const state = (inv) => {
  if (!inv) return new ApiError('INVITATION_NOT_FOUND', 'El link de invitación no existe.', { status: 404 });
  if (inv.used_at) return new ApiError('INVITATION_USED', 'Este link ya fue utilizado.', { status: 410 });
  if (new Date(inv.expires_at) <= new Date()) return new ApiError('INVITATION_EXPIRED', 'Este link venció; pide uno nuevo.', { status: 410 });
  if (inv.attempts >= MAX_ATTEMPTS) return new ApiError('INVITATION_LOCKED', 'Se superó el máximo de intentos para este link; pide uno nuevo.', { status: 423 });
  return null;
};

function clean(v, label) {
  const s = String(v ?? '').trim();
  if (!s || s.length > 100) throw new ApiError('INVALID_PARAMETER', `Falta ${label} o es demasiado largo.`, { status: 400 });
  return s;
}

// Read-only look at a link: what it is for and whether it can still be used (no attempt is spent).
export async function peekInvitation(rawToken, deps = {}) {
  const inv = await (deps.store ?? realStore).findInvitationByHash(hashToken(rawToken));
  const bad = state(inv);
  if (bad) throw bad;
  return { scope: inv.scope ?? 'whatsapp' };
}

export async function loginWithInvitation(rawToken, body, deps = {}) {
  const store = deps.store ?? realStore;
  const silogLogin = deps.silogLogin ?? realSilogLogin;
  const usuario = clean(body?.usuario, 'el usuario de Silogtran');
  const clave = clean(body?.clave, 'la contraseña de Silogtran');
  const hash = hashToken(rawToken);

  const inv = await store.findInvitationByHash(hash);
  const bad = state(inv);
  if (bad) throw bad;

  // A link for a person that already has a Silogtran user must be answered with THAT user (links never re-bind a person to someone else).
  const existing = await store.getUser(inv.user_id);
  if (existing?.silog_user && existing.silog_user.toLowerCase() !== usuario.toLowerCase()) {
    throw new ApiError('SILOG_USER_MISMATCH', 'Este link es de otra persona: el usuario de Silogtran no coincide con el registrado.', { status: 409 });
  }

  if (!(await store.reserveAttempt(hash, inv.attempts))) {
    // Lost a race (or the link changed state between read and write).
    const again = state(await store.findInvitationByHash(hash));
    throw again ?? new ApiError('INVITATION_BUSY', 'Hay otro intento en curso con este link; vuelve a intentar.', { status: 409 });
  }
  const used = inv.attempts + 1;

  let session;
  try {
    session = await silogLogin(usuario, clave);
  } catch (e) {
    if (e?.name === 'SilogtranError' && e.code === 'LOGIN_FAILED') {
      const msg = String(e.message || '');
      const extra = { intentosRestantes: Math.max(MAX_ATTEMPTS - used, 0) };
      if (/password change/i.test(msg)) throw new ApiError('LOGIN_NOT_SUPPORTED', 'Silogtran exige cambiar la contraseña; hazlo en Silogtran y vuelve a intentar.', { status: 422, extra });
      if (/2FA/i.test(msg)) throw new ApiError('LOGIN_NOT_SUPPORTED', 'Este usuario tiene verificación en dos pasos, que no está soportada.', { status: 422, extra });
      const motivo = msg.replace(/^Login failed:\s*/i, '').trim();
      throw new ApiError('LOGIN_REJECTED', 'Usuario o contraseña de Silogtran incorrectos.', {
        status: 401,
        extra: { ...extra, ...(motivo && !/invalid credentials/i.test(motivo) ? { motivoSilogtran: motivo } : {}) },
      });
    }
    // Infrastructure failure (WAF, network, cost center...): not the user's fault, give the attempt back.
    await store.refundAttempt(hash).catch(() => {});
    throw e;
  }

  if (await store.silogUserTaken(usuario, inv.user_id)) {
    throw new ApiError('SILOG_USER_ALREADY_LINKED', 'Ese usuario de Silogtran ya está vinculado a otra persona en la app.', { status: 409 });
  }
  if (!(await store.consumeInvitation(hash))) throw new ApiError('INVITATION_USED', 'Este link ya fue utilizado.', { status: 410 });

  const scope = inv.scope ?? 'whatsapp';
  await store.activateUser(inv.user_id, usuario, clave);
  // The link itself is the administrator's authorization for its purpose (activation links grant the MCP scope).
  if (scope !== 'whatsapp') await (deps.grantScope ?? setScope)(inv.user_id, scope, true);
  await (deps.saveJar ?? saveCookies)(session.jar, inv.user_id);
  const user = await store.getUser(inv.user_id);
  return { user: { id: user.id, nombre: user.nombre, silogUser: user.silog_user }, costCenter: session.costCenter, scope };
}
