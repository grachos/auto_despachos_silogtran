// Read-only diagnostic: loads the SAME plate through "Vehículos Activos" and through the "Empresas" tab on fresh dispatch
// forms and compares which form controls end up filled (and which of them a browser would actually submit).
// Only control ids and flags are reported, NEVER values. Nothing is saved; the pending item is always cleared.
import { ApiError } from '../http/errors.js';
import { buscarSolicitud } from './solicitud.js';
import { clearPending, pickItem, startDispatch } from './despacho.js';
import { PradoPage } from './prado.js';
import { selectVehicle, tabPanels } from './informacion.js';

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

export function diffControls(a, b) {
  const only = (x, y) => Object.keys(x).filter((k) => !(k in y)).sort();
  const differ = Object.keys(a).filter((k) => k in b && (a[k].filled !== b[k].filled || a[k].sent !== b[k].sent || a[k].disabled !== b[k].disabled || a[k].opcion !== b[k].opcion)).sort()
    .map((k) => ({ id: k, activos: a[k], empresas: b[k] }));
  return { soloActivos: only(a, b), soloEmpresas: only(b, a), difieren: differ };
}

export async function diagnoseVehicle(client, numero, { placa, item }) {
  const solicitud = await buscarSolicitud(client, numero);
  const chosen = pickItem(solicitud, item ?? null);
  const run = async (fuente) => {
    try {
      return await client.enqueue(async () => {
        const d = await startDispatch(client, { numero, item: chosen.item, fechaCreacion: solicitud.fechaCreacion });
        const form = new PradoPage(client, d.page);
        const v = await selectVehicle(form, placa, fuente);
        return { ok: true, tipoAfiliado: v.tipoAfiliado, beneficiarios: (v.beneficiarios ?? []).length, pestanas: tabPanels(form).map((p) => ({ id: p.id, vistas: p.views.length, campo: p.hiddenName, activa: p.active })), controles: snapshotControls(form) };
      });
    } catch (e) {
      return { ok: false, code: e?.code ?? 'ERROR', message: String(e?.message ?? '').slice(0, 200) };
    } finally {
      await client.enqueue(() => clearPending(client)).catch(() => {});
    }
  };
  const activos = await run('activos');
  const empresas = await run('empresas');
  if (!activos.ok && !empresas.ok) throw new ApiError('DIAG_NO_DATA', 'La placa no cargó por ninguna de las dos fuentes.', { status: 404, extra: { activos, empresas } });
  const res = { ok: true, solicitud: numero, item: chosen.item, activos: strip(activos), empresas: strip(empresas) };
  if (activos.ok && empresas.ok) res.diferencias = diffControls(activos.controles, empresas.controles);
  return res;
}
const strip = ({ controles, ...rest }) => ({ ...rest, controlesTotal: controles ? Object.keys(controles).length : 0 });
