// Read-only diagnostic: loads the SAME plate through "Vehículos Activos" and through the "Empresas" tab on fresh dispatch
// forms and compares which form controls end up filled (and which of them a browser would actually submit).
// Only control ids and flags are reported, NEVER values. Nothing is saved; the pending item is always cleared.
import * as cheerio from 'cheerio';
import { ApiError } from '../http/errors.js';
import { buscarSolicitud } from './solicitud.js';
import { clearPending, pickItem, startDispatch } from './despacho.js';
import { PradoPage } from './prado.js';
import { selectVehicle, tabPanels, fillInformacion, setConfirmadoPor } from './informacion.js';
import { runPreparation } from './preparar.js';
import { parsePreparar } from '../validation.js';

const P = 'ctl0$MainModule$';

// id -> { tag, disabled, filled, sent } for every control (values are never copied out).
export function snapshotControls(form) {
  const $ = form.$();
  const out = {};
  $('input, select, textarea').each((_, el) => {
    const id = el.attribs.id || el.attribs.name;
    if (!id || /^PRADO_/.test(id) || /PAGESTATE|^ctl0_Page/i.test(id)) return;
    const tag = el.tagName === 'input' ? `input:${(el.attribs.type || 'text').toLowerCase()}` : el.tagName;
    const filled = el.tagName === 'select' ? $(el).find('option[selected]').length > 0 : String(el.attribs.value ?? '').trim() !== '';
    const name = el.attribs.name;
    out[id] = { tag, disabled: el.attribs.disabled !== undefined, filled, sent: !!name && name in form.fields && String(form.fields[name] ?? '') !== '' };
    // Small catalog selects (e.g. "Confirmado Por", "Tipo de operación"): the chosen option's label is a catalog value, not personal data.
    if (el.tagName === 'select' && $(el).find('option').length <= 12) out[id].opcion = $(el).find('option[selected]').first().text().trim().slice(0, 40) || null;
  });
  return out;
}

// What the Empresas "Aceptar" request carried, for the empresa/lock/tab fields only. Technical, non-personal values
// (button lock, active-tab index, button label, postback target) are shown; for the rest only whether they were filled.
export function aceptarSent(form) {
  const sent = form.aceptarSent ?? {};
  const re = /empresa|enturnamiento|IDLockHidden|^PRADO_POSTBACK_TARGET$/i;
  const technical = /IDLockHidden|enturnamiento_\d+$|^PRADO_POSTBACK_TARGET$|Aceptar/i;
  return Object.keys(sent).filter((k) => re.test(k)).sort().map((k) => {
    const v = String(sent[k] ?? '');
    return technical.test(k) || /^(Aceptar|true|false|\d)$/i.test(v) ? `${k.replace(/^ctl0\$MainModule\$/, '')}=${v.slice(0, 40)}` : `${k.replace(/^ctl0\$MainModule\$/, '')} ${v.trim() ? '(lleno)' : '(vacío)'}`;
  });
}

export function diffControls(a, b) {
  const only = (x, y) => Object.keys(x).filter((k) => !(k in y)).sort();
  const differ = Object.keys(a).filter((k) => k in b && (a[k].filled !== b[k].filled || a[k].sent !== b[k].sent || a[k].disabled !== b[k].disabled || a[k].opcion !== b[k].opcion)).sort()
    .map((k) => ({ id: k, activos: a[k], empresas: b[k] }));
  return { soloActivos: only(a, b), soloEmpresas: only(b, a), difieren: differ };
}

const KEY_IDS = ['ctl0_MainModule_fieldHdVehEmpresaID', 'ctl0_MainModule_enturnamiento_codigo', 'ctl0_MainModule_confirmado_por', 'ctl0_MainModule_tipo_operacion', 'ctl0_MainModule_vehiculo_codigo', 'ctl0_MainModule_tercero_codigo_conductor'];

// Page CODE around the vehicle-source tabs (markup + scripts mentioning empresa/confirmado/tab), to find what the browser
// changes when the person clicks "Empresas". Values of inputs are stripped; this is page structure, not personal data.
export function tabHints(html) {
  const $ = cheerio.load(String(html ?? ''));
  const strip = (h) => String(h).replace(/\svalue="[^"]*"/gi, ' value="…"').replace(/\s+/g, ' ').slice(0, 1500);
  const tabs = $('a, li, td, span, div, input[type=button], input[type=submit], button').toArray()
    .filter((el) => /^(veh[ií]culos activos|empresas)$/i.test($(el).text().trim()) || /^(veh[ií]culos activos|empresas)$/i.test(String(el.attribs.value ?? '').trim()))
    .slice(0, 6).map((el) => strip($.html($(el).parent())));
  const scripts = $('script').toArray().map((el) => $(el).html() ?? '')
    .flatMap((js) => [...js.matchAll(/[^;{}\n]{0,250}(empresa|confirmado|activo|tab)[^;{}\n]{0,250}/gi)].map((m) => m[0].trim()))
    .filter((x, i, a) => a.indexOf(x) === i).slice(0, 40).map((x) => x.slice(0, 400));
  const hidden = $('input[type=hidden]').toArray().map((el) => `${el.attribs.id || el.attribs.name}${String(el.attribs.value ?? '').trim() ? ' (lleno)' : ''}`).filter((x) => !/PRADO_/.test(x));
  // Every PRADO client-side control/callback definition (autocompletes, event-triggered callbacks, active buttons...) that mentions an
  // Empresas/enturnamiento/Aceptar control: shows whether choosing the plate or pressing Aceptar fires any extra AJAX callback.
  const all = $('script').toArray().map((el) => $(el).html() ?? '').join('\n');
  const callbacks = [...all.matchAll(/Prado\.(?:WebUI|CallbackRequest)[\w.]*\(\s*\{[^;]*?\}\s*\)\s*;/g)].map((m) => m[0].replace(/\s+/g, ' ').trim())
    .filter((x) => /empresa|enturn|aceptar/i.test(x)).filter((x, i, arr) => arr.indexOf(x) === i).slice(0, 30).map((x) => x.slice(0, 600));
  return { tabs, scripts, callbacks, hidden };
}

// Dry run of EVERYTHING `confirmar` does before pressing "Grabar" (vehicle, route, dates, observaciones, anticipo "cero",
// Confirmado Por) and report the form fields that WOULD be posted: names + filled flag, and the value only for catalog /
// internal-id fields (never names or documents). Nothing is saved; the pending item is cleared.
export async function dryRunSave(client, numero, { placa, item, fuente }) {
  const tomorrow = (d) => new Date(Date.now() + d * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  const input = parsePreparar({ placa, item, fuente, citaCargue: { fecha: tomorrow(1), hora: '08:00' }, citaDescargue: { fecha: tomorrow(2), hora: '16:00' } });
  try {
    const { form } = await runPreparation(client, numero, input, { keepOpen: true });
    await client.enqueue(async () => { setConfirmadoPor(form, fuente); });
    const SHOW = /IDHidden$|enturnamiento|fieldHd|confirmado|tipo_operacion|tipafi|tipo_manifiesto|tipmanrndc|Anticipo$|beneficiario|Generar$|Aceptar|IDLock/i;
    const campos = Object.keys(form.fields).filter((k) => !/^PRADO_/.test(k)).sort().map((k) => {
      const v = String(form.fields[k] ?? '');
      return SHOW.test(k) ? `${k.replace('ctl0$MainModule$', '')}=${v.slice(0, 24)}` : `${k.replace('ctl0$MainModule$', '')}${v ? '' : ' (vacío)'}`;
    });
    return { ok: true, solicitud: numero, fuente, total: campos.length, campos };
  } finally {
    await client.enqueue(() => clearPending(client)).catch(() => {});
  }
}

export async function diagnoseVehicle(client, numero, { placa, item, completo = false, codigo = false }) {
  const solicitud = await buscarSolicitud(client, numero);
  const chosen = pickItem(solicitud, item ?? null);
  const run = async (fuente) => {
    try {
      return await client.enqueue(async () => {
        const d = await startDispatch(client, { numero, item: chosen.item, fechaCreacion: solicitud.fechaCreacion });
        const form = new PradoPage(client, d.page);
        if (codigo) return { ok: true, codigo: tabHints(form.html) };
        if (completo) {
          // Full "Información Despacho" fill (vehicle, route, dates, manifest type, tipo_operacion, confirmado_por) WITHOUT
          // observaciones/anticipo/save, to see which hidden fields survive the later callbacks.
          let error = null;
          try { await fillInformacion(form, { placa, fuente, origen: chosen.origen, destino: chosen.destino }); } catch (e) { error = e?.code ?? 'ERROR'; }
          const all = snapshotControls(form);
          const rel = Object.fromEntries(Object.entries(all).filter(([k]) => /empresa|enturnamiento|IDLockHidden/i.test(k)));
          return { ok: !error, error, clave: Object.fromEntries(KEY_IDS.map((k) => [k, all[k] ?? null])), relacionados: rel, aceptarEnviado: aceptarSent(form), controles: all };
        }
        const v = await selectVehicle(form, placa, fuente);
        return { ok: true, tipoAfiliado: v.tipoAfiliado, beneficiarios: (v.beneficiarios ?? []).length, pestanas: tabPanels(form).map((p) => ({ id: p.id, vistas: p.views.length, campo: p.hiddenName, activa: p.active })), controles: snapshotControls(form) };
      });
    } catch (e) {
      return { ok: false, code: e?.code ?? 'ERROR', message: String(e?.message ?? '').slice(0, 200) };
    } finally {
      await client.enqueue(() => clearPending(client)).catch(() => {});
    }
  };
  if (codigo) return { ok: true, solicitud: numero, ...(await run('activos')) };
  const activos = await run('activos');
  const empresas = await run('empresas');
  if (!activos.ok && !empresas.ok) throw new ApiError('DIAG_NO_DATA', 'La placa no cargó por ninguna de las dos fuentes.', { status: 404, extra: { activos, empresas } });
  const res = { ok: true, solicitud: numero, item: chosen.item, activos: strip(activos), empresas: strip(empresas) };
  if (activos.ok && empresas.ok) res.diferencias = diffControls(activos.controles, empresas.controles);
  return res;
}
const strip = ({ controles, ...rest }) => ({ ...rest, controlesTotal: controles ? Object.keys(controles).length : 0 });
