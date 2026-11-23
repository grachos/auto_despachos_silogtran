// M7.2: how the advance of ONE batch row is decided once Silogtran says whether the vehicle is internal or external.
// The table already carries the choice (cero | total | amount [+ beneficiary]); here it is checked against the real vehicle:
//   INTERNO: only cero or total (the beneficiary is the driver).
//   EXTERNO: cero, total (= the maximum Silogtran calculated) or an amount up to the maximum; beneficiary only matters above zero.
// Returns { ok:true, interno:'cero'|'total' } | { ok:true, eleccion } | { ok:false, code, text } (the row is rejected with that text).
import { chooseExternal } from '../ai/tools.js';

const pesos = (n) => `$${Number(n).toLocaleString('es-CO')}`;

export function chooseBatchAdvance(resumen, input) {
  const max = Number(resumen.anticipoSugerido) || 0;
  const wanted = input.anticipo ?? 0; // blank was already turned into cero when the table was read
  if (resumen.tipoAfiliado !== 'EXTERNO') {
    if (wanted === 0) return { ok: true, interno: 'cero' };
    if (wanted === 'total') return { ok: true, interno: max > 0 ? 'total' : 'cero' };
    return { ok: false, code: 'ANTICIPO_NOT_ALLOWED', text: `vehículo interno: el anticipo solo puede ser cero o total (pediste ${pesos(wanted)}).` };
  }
  const amount = wanted === 'total' ? max : wanted;
  if (!Number.isSafeInteger(amount) || amount < 0) return { ok: false, code: 'ANTICIPO_INVALID', text: 'el anticipo no es válido.' };
  if (amount > max) return { ok: false, code: 'ANTICIPO_EXCEEDS', text: `el anticipo pedido (${pesos(amount)}) supera el máximo de la ruta (${pesos(max)}).` };
  // userText undefined = the values come from the table (structured), not from free text: no «did the person say it» check.
  const ext = chooseExternal(resumen, { beneficiario: input.beneficiario ?? null, anticipo: amount }, undefined);
  if (ext.eleccion) return { ok: true, eleccion: ext.eleccion };
  return { ok: false, code: 'BENEFICIARY_REQUIRED', text: `vehículo externo con anticipo de ${pesos(amount)}: falta el beneficiario (conductor o poseedor) en la tabla.` };
}
