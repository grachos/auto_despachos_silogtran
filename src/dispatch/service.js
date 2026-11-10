// HTTP-independent dispatch operations for a given actor (user id, or null = user zero).
// The WhatsApp assistant (M5) calls these directly; the HTTP routes are thin wrappers.
import { randomUUID } from 'node:crypto';
import { ApiError } from '../http/errors.js';
import { parsePreparar } from '../validation.js';
import { assertTokenSecret, signToken } from '../token.js';
import { withLock } from '../store/locks.js';
import { assertActorActive, openActorSession, sessionKey } from '../silogtran/userSession.js';
import { buscarSolicitud } from '../silogtran/solicitud.js';
import { runPreparation } from '../silogtran/preparar.js';
import { readVisorList } from '../silogtran/lista.js';
import { plateExists } from '../silogtran/placa.js';
import { getUser } from '../store/usuarios.js';

export function assertNumero(raw) {
  const numero = String(raw ?? '').trim();
  if (!/^\d{4,20}$/.test(numero)) {
    throw new ApiError('INVALID_PARAMETER', 'El número de solicitud debe contener solo dígitos (4 a 20).', { status: 400 });
  }
  return numero;
}

// Every flow that uses a Silogtran cookie jar takes the jar's lock (see store/locks.js).
export async function consultSolicitud(userId, rawNumero) {
  const numero = assertNumero(rawNumero);
  await assertActorActive(userId);
  return withLock(sessionKey(userId), async () => {
    const { client } = await openActorSession(userId);
    return buscarSolicitud(client, numero);
  });
}

export async function prepareDispatch(userId, rawNumero, body) {
  assertTokenSecret(); // fail before touching Silogtran
  const numero = assertNumero(rawNumero);
  const input = parsePreparar(body);
  await assertActorActive(userId);
  return withLock(sessionKey(userId), async () => {
    const { client } = await openActorSession(userId);
    const { summary, item } = await runPreparation(client, numero, input);
    // uid is always written (null = user zero) so the token is bound to its owner.
    const token = signToken({ jti: randomUUID(), uid: userId ?? null, numero, item, input, anticipo: summary.anticipoSugerido });
    return { ok: true, resumen: summary, token, tokenExpiraEnSegundos: 900 };
  });
}

// Requests with free slots for the "which can I dispatch?" question: one read of the viewer with the actor's own session.
// Returns every row of the viewer plus the actor's Silogtran user name (to show their own requests first).
export async function listSolicitudes(userId) {
  await assertActorActive(userId);
  const miUsuario = userId ? (await getUser(userId))?.silog_user ?? null : process.env.SILOG_USER ?? null;
  return withLock(sessionKey(userId), async () => {
    const { client } = await openActorSession(userId);
    return { rows: await client.enqueue(() => readVisorList(client)), miUsuario };
  });
}

// Quick read-only check of the plate in the vehicle master, BEFORE the slow dispatch preparation. true | false | null (null = unknown:
// session busy, page changed, any error; the caller then just continues and the normal preparation decides).
export async function checkPlate(userId, placa) {
  try {
    await assertActorActive(userId);
    return await withLock(sessionKey(userId), async () => {
      const { client } = await openActorSession(userId);
      return client.enqueue(() => plateExists(client, placa));
    });
  } catch (e) {
    console.error('[placa] check skipped:', e?.code || e?.name || 'error');
    return null;
  }
}
