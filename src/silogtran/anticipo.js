// Step 8: anticipo. "total" -> Pago Anticipos row (TRANSFERENCIA POR ARCHIVO, BANCOLOMBIA PROPIOS);
// "cero" -> Anticipo = 0 and the change callback. Verified from the resulting table.
import { ApiError } from '../http/errors.js';
import { norm } from './text.js';
import { need, parseMoney, resolveOption, selectOptions } from './informacion.js';
import { readTable } from './pestanas.js';

const P = 'ctl0$MainModule$';

export async function setAnticipoCero(form) {
  form.fields[need(form, `${P}Anticipo`)] = '0';
  for (const t of form.triggers('ctl0_MainModule_Anticipo', 'change', [`${P}ctl32`])) await form.callback(t);
}

// Bank by affiliate type: INTERNO -> BANCOLOMBIA PROPIOS (ID 3), EXTERNO -> BANCOLOMBIA TERCEROS (ID 2).
const BANKS = {
  propios: { query: 'BANCOLOMBIA%PROPIOS', name: 'bancolombia propios', label: 'BANCOLOMBIA PROPIOS' },
  terceros: { query: 'BANCOLOMBIA%TERCEROS', name: 'bancolombia terceros', label: 'BANCOLOMBIA TERCEROS' },
};

// Partial anticipo (0 < value < calculated): set the Anticipo field and fire the same change callback as "cero".
export async function setAnticipoValor(form, value) {
  form.fields[need(form, `${P}Anticipo`)] = String(value); // no thousands separator
  for (const t of form.triggers('ctl0_MainModule_Anticipo', 'change', [`${P}ctl32`])) await form.callback(t);
}

export function setBeneficiario(form, id) {
  form.fields[need(form, `${P}tercero_beneficiario_anticipo`)] = String(id);
}

export async function addAnticipoPago(form, anticipo, bank = 'propios') {
  const b = BANKS[bank];
  const tipoName = need(form, `${P}tipegr_codigo`);
  const tipo = resolveOption(selectOptions(form, tipoName), 'TRANSFERENCIA POR ARCHIVO', 'el tipo de pago');
  form.fields[tipoName] = tipo.value;
  for (const t of form.triggers('ctl0_MainModule_tipegr_codigo', 'blur', [`${P}ctl37`])) await form.callback(t);

  form.fields[need(form, `${P}ValorPago`)] = String(anticipo); // no thousands separator

  const bancoName = need(form, `${P}banco_codigo`);
  const results = await form.suggest(bancoName, b.query);
  const attr = 'ctl0_mainmodule_banco_codigo';
  const banks = results.filter((r) => norm(r.attrs[attr]) === b.name);
  if (banks.length !== 1) {
    throw new ApiError('BANK_NOT_FOUND', `No se encontró el banco ${b.label} en Silogtran.`, { status: 502, detail: `resultados=${results.length}` });
  }
  form.select(banks[0]);
  for (const t of form.triggers('ctl0_MainModule_banco_codigo', 'change', [`${P}ctl42`])) await form.callback(t);

  const target = form.buttonByGroup('Requeridosanticipo', `${P}ctl49`);
  await form.postback(target, { [target]: 'Adicionar' });
  const ok = readTable(form, '#ctl0_MainModule_ItemsPago').some(
    (r) => norm(r['tipo pago']) === 'transferencia por archivo' && parseMoney(r.valor) === anticipo,
  );
  if (!ok) throw new ApiError('ANTICIPO_PAGO_NOT_ADDED', 'Silogtran no agregó el pago del anticipo.', { status: 502 });
}
