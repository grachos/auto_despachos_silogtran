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
