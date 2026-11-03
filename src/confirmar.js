// `confirmar`: redo the fill from the signed token, check the anticipo, add the payment, save, read RNDC.
// Idempotent per token and locked per request number (see store/confirmaciones.js).
import { ApiError } from './http/errors.js';
import { verifyToken } from './token.js';
import { claimConfirmation, markConfirmation } from './store/confirmaciones.js';
import { openSession } from './silogtran/session.js';
import { runPreparation } from './silogtran/preparar.js';
import { clearPending } from './silogtran/despacho.js';
import { addAnticipoPago, setAnticipoCero } from './silogtran/anticipo.js';
import { postGenerar, readRndc } from './silogtran/grabar.js';

export function parseConfirmar(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (typeof b.token !== 'string' || !b.token) throw new ApiError('INVALID_PARAMETER', 'Falta el token devuelto por preparar.', { status: 400 });
  if (!['total', 'cero'].includes(b.anticipo)) throw new ApiError('INVALID_PARAMETER', 'El campo anticipo debe ser "total" o "cero".', { status: 400 });
  return { token: b.token, anticipo: b.anticipo };
}

function buildMessage(documents, rndc) {
  const ministry = rndc?.migrated ? `Radicado Ministerio ${rndc.radicado}` : rndc ? 'Sin migrar al Ministerio' : 'Estado del Ministerio no verificado';
  return `Se despachó a satisfacción. Remesa ${documents.remesa}, Manifiesto ${documents.manifiesto}. ${ministry}.`;
}

export async function confirmDispatch(numero, { token, anticipo }) {
  const payload = verifyToken(token);
  if (payload.numero !== numero || !payload.jti || !payload.input) {
    throw new ApiError('TOKEN_INVALID', 'El token no corresponde a esta solicitud; vuelve a ejecutar preparar.', { status: 400 });
  }
  const claim = await claimConfirmation(payload.jti, numero);
  if (claim.state === 'DONE') return { ...claim.result, repeated: true };
  if (claim.state === 'UNKNOWN') {
    throw new ApiError('CONFIRMATION_UNKNOWN', 'No se sabe si este despacho se guardó. Verifica en Silogtran antes de reintentar con un token nuevo.', { status: 409 });
  }

  const t0 = Date.now();
  const base = { user_id: payload.uid ?? null, placa: payload.input.placa ?? null, solicitud_item: payload.item ?? null, anticipo_modo: anticipo };
  let prepareMs = null;
  const { client } = await openSession();
  let saving = false;
  try {
    const tPrep = Date.now();
    const { form, summary } = await runPreparation(client, numero, payload.input, { keepOpen: true });
    prepareMs = Date.now() - tPrep;
    if (summary.anticipoSugerido !== payload.anticipo) {
      throw new ApiError('ANTICIPO_CHANGED', 'El anticipo cambió desde preparar; vuelve a ejecutar preparar.', {
        status: 409,
        extra: { anticipoAnterior: payload.anticipo, anticipoActual: summary.anticipoSugerido },
      });
    }
    await client.enqueue(async () => {
      if (anticipo === 'cero') await setAnticipoCero(form);
      else if (payload.anticipo > 0) await addAnticipoPago(form, payload.anticipo);
    });

    saving = true;
    const tSave = Date.now();
    const saved = await client.enqueue(() => postGenerar(client, form));
    const saveMs = Date.now() - tSave;
    if (!saved.saved || !saved.documents.remesa || !saved.documents.manifiesto) {
      const detail = saved.rawMessage || 'sin mensaje';
      if (!saved.saved && saved.rawMessage) {
        // Silogtran answered with an error message and did not save.
        await markConfirmation(payload.jti, 'FAILED', { detail, fields: { ...base, prepare_ms: prepareMs, save_ms: saveMs, total_ms: Date.now() - t0, error_code: 'SAVE_REJECTED' } });
        await client.enqueue(() => clearPending(client)).catch(() => {});
        throw new ApiError('SAVE_REJECTED', 'Silogtran no guardó el despacho.', { status: 422, detail });
      }
      await markConfirmation(payload.jti, 'UNKNOWN', { detail, fields: { ...base, prepare_ms: prepareMs, save_ms: saveMs, total_ms: Date.now() - t0, error_code: 'SAVE_RESULT_UNKNOWN' } });
      throw new ApiError('SAVE_RESULT_UNKNOWN', 'No se pudo leer el resultado del guardado en Silogtran. Verifica en Silogtran antes de reintentar.', { status: 502, detail });
    }
    // Persist the saved state before the (optional) RNDC read, so a timeout cannot lose it.
    const out = { ok: true, status: 'DISPATCHED', documents: saved.documents, rndc: null, warnings: saved.warnings };
    const metrics = {
      ...base, anticipo_valor: anticipo === 'total' ? payload.anticipo : 0,
      orden_cargue: saved.documents.ordenCargue, remesa: saved.documents.remesa, manifiesto: saved.documents.manifiesto, transferencia: saved.documents.transferencia,
      prepare_ms: prepareMs, save_ms: saveMs, total_ms: Date.now() - t0,
    };
    await markConfirmation(payload.jti, 'DONE', { result: { ...out, message: buildMessage(saved.documents, null) }, fields: metrics });

    let rndc = null;
    try {
      rndc = await client.enqueue(() => readRndc(client, saved.documents.manifiesto));
    } catch (e) {
      out.warnings = [...out.warnings, 'No se pudo consultar el estado del Ministerio.'];
    }
    const result = { ...out, status: rndc && !rndc.migrated ? 'DISPATCHED_NOT_MIGRATED' : 'DISPATCHED', rndc, message: buildMessage(saved.documents, rndc) };
    await markConfirmation(payload.jti, 'DONE', {
      result,
      fields: rndc ? { radicado: rndc.radicado, rndc_migrated: rndc.migrated, rndc_fecha_hora: rndc.fechaHora, rndc_checked_at: new Date().toISOString() } : undefined,
    });
    return result;
  } catch (e) {
    if (!saving) {
      // Failed before pressing Grabar: nothing saved, release the token and clear the pending item.
      await markConfirmation(payload.jti, 'FAILED', { detail: e?.code || e?.message, fields: { ...base, prepare_ms: prepareMs, total_ms: Date.now() - t0, error_code: e?.code || 'ERROR' } });
      await client.enqueue(() => clearPending(client)).catch(() => {});
    } else if (e?.code === 'SAVE_RESULT_UNKNOWN') {
      await markConfirmation(payload.jti, 'UNKNOWN', { detail: e?.detail, fields: { ...base, prepare_ms: prepareMs, total_ms: Date.now() - t0, error_code: 'SAVE_RESULT_UNKNOWN' } });
    }
    throw e;
  }
}
