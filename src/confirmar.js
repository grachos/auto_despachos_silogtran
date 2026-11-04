// `confirmar`: redo the fill from the signed token, check the anticipo, add the payment, save, read RNDC.
// Idempotent per token, locked per request number (store/confirmaciones.js) and per Silogtran session (store/locks.js).
// The token carries its owner (`uid`, null = user zero): the session used is always the owner's.
import { ApiError } from './http/errors.js';
import { verifyToken } from './token.js';
import { claimConfirmation, markConfirmation } from './store/confirmaciones.js';
import { withLock } from './store/locks.js';
import { assertActorActive, openActorSession, resolveActorId, sessionKey } from './silogtran/userSession.js';
import { runPreparation } from './silogtran/preparar.js';
import { clearPending } from './silogtran/despacho.js';
import { addAnticipoPago, setAnticipoCero, setAnticipoValor, setBeneficiario } from './silogtran/anticipo.js';
import { postGenerar, readRndc } from './silogtran/grabar.js';

export function parseConfirmar(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (typeof b.token !== 'string' || !b.token) throw new ApiError('INVALID_PARAMETER', 'Falta el token devuelto por preparar.', { status: 400 });
  const a = typeof b.anticipo === 'string' && /^\d+$/.test(b.anticipo.trim()) ? Number(b.anticipo) : b.anticipo;
  if (!(['total', 'cero'].includes(a) || (Number.isSafeInteger(a) && a >= 0))) {
    throw new ApiError('INVALID_PARAMETER', 'El campo anticipo debe ser "total", "cero" o un valor entero en pesos.', { status: 400 });
  }
  const ben = b.beneficiario === undefined || b.beneficiario === null || b.beneficiario === '' ? undefined : String(b.beneficiario).trim();
  return { token: b.token, anticipo: a, beneficiario: ben, usuario: b.usuario };
}

// "total" | "cero" | number -> { mode, value } against the calculated anticipo (from the signed token).
export function resolveAnticipo(anticipo, calculated) {
  const value = anticipo === 'total' ? calculated : anticipo === 'cero' ? 0 : anticipo;
  if (value > calculated) {
    throw new ApiError('ANTICIPO_EXCEEDS', `El anticipo no puede superar el calculado por Silogtran ($${calculated}).`, { status: 400, extra: { maximo: calculated } });
  }
  return { mode: anticipo === 'total' || (value > 0 && value === calculated) ? 'total' : value === 0 ? 'cero' : 'valor', value };
}

// Affiliate rules. EXTERNO: beneficiary required (from Silogtran's list), any value 0..calculated, bank TERCEROS.
// Anything else (INTERNO): beneficiary is the driver (default, untouched), only total/zero, bank PROPIOS.
export function applyRules(summary, { beneficiario, mode }) {
  const options = summary.beneficiarios ?? [];
  if (summary.tipoAfiliado === 'EXTERNO') {
    if (!beneficiario) {
      throw new ApiError('BENEFICIARY_REQUIRED', 'El vehículo es externo: indica el beneficiario del anticipo (conductor o poseedor).', { status: 400, extra: { options } });
    }
    if (!options.some((o) => o.id === beneficiario)) {
      throw new ApiError('BENEFICIARY_INVALID', 'El beneficiario no está en la lista de Silogtran para este vehículo.', { status: 400, extra: { options } });
    }
    return { bank: 'terceros', beneficiario };
  }
  if (beneficiario && options.find((o) => o.id === beneficiario)?.rol !== 'conductor') {
    throw new ApiError('BENEFICIARY_INVALID', 'En un vehículo interno el beneficiario siempre es el conductor.', { status: 400 });
  }
  if (mode === 'valor') throw new ApiError('ANTICIPO_NOT_ALLOWED', 'En un vehículo interno el anticipo solo puede ser total o cero.', { status: 400 });
  return { bank: 'propios', beneficiario: null };
}

function buildMessage(documents, rndc) {
  const ministry = rndc?.migrated ? `Radicado Ministerio ${rndc.radicado}` : rndc ? 'Sin migrar al Ministerio' : 'Estado del Ministerio no verificado';
  return `Se despachó a satisfacción. Remesa ${documents.remesa}, Manifiesto ${documents.manifiesto}. ${ministry}.`;
}

const realDeps = {
  verifyToken, resolveActorId, assertActorActive, withLock, sessionKey, claimConfirmation, markConfirmation,
  openActorSession, runPreparation, clearPending, setAnticipoCero, setAnticipoValor, setBeneficiario, addAnticipoPago, postGenerar, readRndc,
};

export async function confirmDispatch(numero, { token, anticipo, beneficiario, usuario }, d = realDeps) {
  const payload = d.verifyToken(token);
  if (payload.numero !== numero || !payload.jti || !payload.input) {
    throw new ApiError('TOKEN_INVALID', 'El token no corresponde a esta solicitud; vuelve a ejecutar preparar.', { status: 400 });
  }
  const uid = payload.uid ?? null;
  const plan = resolveAnticipo(anticipo, payload.anticipo); // fail fast, before touching Silogtran
  if (usuario !== undefined && usuario !== null && String(usuario).trim() !== '') {
    const asked = await d.resolveActorId(usuario);
    if (asked !== uid) throw new ApiError('TOKEN_USER_MISMATCH', 'Este token pertenece a otro usuario.', { status: 403 });
  }
  await d.assertActorActive(uid); // DB only: fail fast (RELINK_REQUIRED / USER_NOT_ACTIVE) without touching Silogtran
  // Take the session lock BEFORE claiming anything, so a busy user leaves no claim behind.
  return d.withLock(d.sessionKey(uid), () => runConfirmation(numero, { payload, uid, plan, beneficiario }, d));
}

async function runConfirmation(numero, { payload, uid, plan, beneficiario }, d) {
  const claim = await d.claimConfirmation(payload.jti, numero);
  if (claim.state === 'DONE') return { ...claim.result, repeated: true };
  if (claim.state === 'UNKNOWN') {
    throw new ApiError('CONFIRMATION_UNKNOWN', 'No se sabe si este despacho se guardó. Verifica en Silogtran antes de reintentar con un token nuevo.', { status: 409 });
  }

  const t0 = Date.now();
  const base = { user_id: uid, placa: payload.input.placa ?? null, solicitud_item: payload.item ?? null, anticipo_modo: plan.mode };
  let prepareMs = null;
  let client;
  let saving = false;
  try {
    // Opening the session can fail (WAF, network, relink): that must mark the claim FAILED (retryable), not leave it PROCESSING.
    ({ client } = await d.openActorSession(uid));
    const tPrep = Date.now();
    const { form, summary } = await d.runPreparation(client, numero, payload.input, { keepOpen: true });
    prepareMs = Date.now() - tPrep;
    if (summary.anticipoSugerido !== payload.anticipo) {
      throw new ApiError('ANTICIPO_CHANGED', 'El anticipo cambió desde preparar; vuelve a ejecutar preparar.', {
        status: 409,
        extra: { anticipoAnterior: payload.anticipo, anticipoActual: summary.anticipoSugerido },
      });
    }
    const rules = applyRules(summary, { beneficiario, mode: plan.mode });
    await client.enqueue(async () => {
      if (rules.beneficiario) d.setBeneficiario(form, rules.beneficiario);
      if (plan.mode === 'cero') await d.setAnticipoCero(form);
      else {
        if (plan.mode === 'valor') await d.setAnticipoValor(form, plan.value);
        if (plan.value > 0) await d.addAnticipoPago(form, plan.value, rules.bank);
      }
    });

    saving = true;
    const tSave = Date.now();
    const saved = await client.enqueue(() => d.postGenerar(client, form));
    const saveMs = Date.now() - tSave;
    if (!saved.saved || !saved.documents.remesa || !saved.documents.manifiesto) {
      const detail = saved.rawMessage || 'sin mensaje';
      if (!saved.saved && saved.rawMessage) {
        // Silogtran answered with an error message and did not save.
        await d.markConfirmation(payload.jti, 'FAILED', { detail, fields: { ...base, prepare_ms: prepareMs, save_ms: saveMs, total_ms: Date.now() - t0, error_code: 'SAVE_REJECTED' } });
        await client.enqueue(() => d.clearPending(client)).catch(() => {});
        throw new ApiError('SAVE_REJECTED', 'Silogtran no guardó el despacho.', { status: 422, detail });
      }
      await d.markConfirmation(payload.jti, 'UNKNOWN', { detail, fields: { ...base, prepare_ms: prepareMs, save_ms: saveMs, total_ms: Date.now() - t0, error_code: 'SAVE_RESULT_UNKNOWN' } });
      throw new ApiError('SAVE_RESULT_UNKNOWN', 'No se pudo leer el resultado del guardado en Silogtran. Verifica en Silogtran antes de reintentar.', { status: 502, detail });
    }
    // Persist the saved state before the (optional) RNDC read, so a timeout cannot lose it.
    const out = { ok: true, status: 'DISPATCHED', documents: saved.documents, rndc: null, warnings: saved.warnings };
    const metrics = {
      ...base, anticipo_valor: plan.value,
      orden_cargue: saved.documents.ordenCargue, remesa: saved.documents.remesa, manifiesto: saved.documents.manifiesto, transferencia: saved.documents.transferencia,
      prepare_ms: prepareMs, save_ms: saveMs, total_ms: Date.now() - t0,
    };
    await d.markConfirmation(payload.jti, 'DONE', { result: { ...out, message: buildMessage(saved.documents, null) }, fields: metrics });

    let rndc = null;
    try {
      rndc = await client.enqueue(() => d.readRndc(client, saved.documents.manifiesto));
    } catch (e) {
      out.warnings = [...out.warnings, 'No se pudo consultar el estado del Ministerio.'];
    }
    const result = { ...out, status: rndc && !rndc.migrated ? 'DISPATCHED_NOT_MIGRATED' : 'DISPATCHED', rndc, message: buildMessage(saved.documents, rndc) };
    await d.markConfirmation(payload.jti, 'DONE', {
      result,
      fields: rndc ? { radicado: rndc.radicado, rndc_migrated: rndc.migrated, rndc_fecha_hora: rndc.fechaHora, rndc_checked_at: new Date().toISOString() } : undefined,
    });
    return result;
  } catch (e) {
    if (!saving) {
      // Failed before pressing Grabar (including failing to open the session): nothing saved -> retryable.
      await d.markConfirmation(payload.jti, 'FAILED', { detail: e?.code || e?.message, fields: { ...base, prepare_ms: prepareMs, total_ms: Date.now() - t0, error_code: e?.code || 'ERROR' } });
      await client?.enqueue(() => d.clearPending(client)).catch(() => {});
    } else if (e?.code === 'SAVE_RESULT_UNKNOWN') {
      await d.markConfirmation(payload.jti, 'UNKNOWN', { detail: e?.detail, fields: { ...base, prepare_ms: prepareMs, total_ms: Date.now() - t0, error_code: 'SAVE_RESULT_UNKNOWN' } });
    }
    throw e;
  }
}
