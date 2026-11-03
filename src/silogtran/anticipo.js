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

export async function addAnticipoPago(form, anticipo) {
  const tipoName = need(form, `${P}tipegr_codigo`);
  const tipo = resolveOption(selectOptions(form, tipoName), 'TRANSFERENCIA POR ARCHIVO', 'el tipo de pago');
  form.fields[tipoName] = tipo.value;
  for (const t of form.triggers('ctl0_MainModule_tipegr_codigo', 'blur', [`${P}ctl37`])) await form.callback(t);

  form.fields[need(form, `${P}ValorPago`)] = String(anticipo); // no thousands separator

  const bancoName = need(form, `${P}banco_codigo`);
  const results = await form.suggest(bancoName, 'BANCOLOMBIA%PROPIOS');
  const attr = 'ctl0_mainmodule_banco_codigo';
  const banks = results.filter((r) => norm(r.attrs[attr]) === 'bancolombia propios');
  if (banks.length !== 1) {
    throw new ApiError('BANK_NOT_FOUND', 'No se encontró el banco BANCOLOMBIA PROPIOS en Silogtran.', { status: 502, detail: `resultados=${results.length}` });
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
