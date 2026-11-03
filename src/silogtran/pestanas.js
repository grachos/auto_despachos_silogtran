// Tabs "Observaciones Documentos" and "Contenedores" (steps 9-10). Adicionar is a full postback whose
// client-side validation does not exist server-side: an incomplete add is silently ignored, so every add
// is verified by reading the resulting table.
import { ApiError } from '../http/errors.js';
import { norm, cell } from './text.js';
import { need } from './informacion.js';

const P = 'ctl0$MainModule$';

// Rows of a table as { normalizedHeader: cellText }.
export function readTable(form, selector) {
  const $ = form.$();
  const rows = $(`${selector} tr`).toArray();
  if (!rows.length) return [];
  const headers = $(rows[0]).find('th').toArray().map((th) => norm($(th).text()));
  return rows.slice(1).map((tr) => {
    const tds = $(tr).children('td').toArray().map((td) => cell($(td).text()));
    return Object.fromEntries(headers.map((h, i) => [h, tds[i] ?? '']));
  });
}

function tableHas(form, selector, match) {
  return readTable(form, selector).some((row) => Object.entries(match).every(([h, v]) => norm(row[h]) === norm(v)));
}

export async function addObservaciones(form, { numero, item, input }) {
  const values = {
    itemobservaciones_ordenCompra: input.ordenCompra,
    itemobservaciones_Ordencargue: input.observacionOrdenCargue,
    itemobservaciones_Remesa: input.observacionRemesa,
    remesa_fechacompromiso: input.citaCargue.fecha,
    remesa_horacompromiso: input.citaCargue.hora,
    remesa_tiempohoraspactadascargue: '2',
    remesa_tiempominutospactadoscargue: '0',
    remesa_citadescarguefecha: input.citaDescargue.fecha,
    remesa_citadescarguehora: input.citaDescargue.hora,
    remesa_tiempohoraspactadasdescargue: '2',
    remesa_tiempominutospactadosdescargue: '0',
  };
  for (const [k, v] of Object.entries(values)) form.fields[need(form, P + k)] = v;
  const target = form.buttonByGroup('Requeridosobservaciones', `${P}ctl51`);
  await form.postback(target, { [target]: 'Adicionar' });
  const solicitud = `${numero}-${item}`;
  if (!tableHas(form, '#ctl0_MainModule_ItemsObservaciones', { solicitud })) {
    throw new ApiError('OBSERVACIONES_NOT_ADDED', 'Silogtran no agregó las observaciones de documentos.', { status: 502, detail: solicitud });
  }
}

export async function addContenedor(form, { input }) {
  const field = (n) => need(form, P + n);
  const numero = input.contenedor;
  const results = await form.suggest(field('itemremesacontenedor_ContenedorCodigo'), numero);
  const attr = 'ctl0_mainmodule_itemremesacontenedor_contenedorcodigo';
  if (!results.length) throw new ApiError('CONTAINER_NOT_FOUND', `El contenedor ${numero} no existe en Silogtran.`, { status: 404 });
  const exact = results.filter((r) => norm(r.attrs[attr]) === norm(numero));
  const pick = exact.length === 1 ? exact[0] : results.length === 1 ? results[0] : null;
  if (!pick) {
    throw new ApiError('AMBIGUOUS_OPTION', `Hay varios contenedores para "${numero}"; indica el número exacto.`, {
      status: 409,
      extra: { options: results.map((r) => r.attrs[attr]) },
    });
  }
  form.select(pick);
  form.fields[field('itemremesacontenedor_IteremconNumerobl')] = input.bl;

  // The container autocomplete may leave the hidden "Detalle Contenedor" place empty, which is required.
  const lugarId = `${P}lugar_codigo$IDHidden`;
  if (!form.fields[lugarId]) {
    const sitio = form.fields[field('itemremesacontenedor_LugarCodigo')] || '';
    const lugares = await form.suggest(field('lugar_codigo'), '%');
    const lAttr = 'ctl0_mainmodule_lugar_codigo';
    const match = lugares.filter((l) => norm(l.attrs[lAttr]) === norm(sitio));
    if (match.length !== 1) {
      throw new ApiError('CONTAINER_PLACE_NOT_FOUND', 'No se pudo determinar el lugar del contenedor en Silogtran.', {
        status: 502,
        detail: `sitioEntrega="${sitio}" opciones=${lugares.map((l) => l.attrs[lAttr]).join('|')}`,
      });
    }
    form.select(match[0]);
  }

  const target = form.buttonByGroup('Requeridosdetallecontenedor', `${P}ctl59`);
  await form.postback(target, { [target]: 'Adicionar' });
  if (!tableHas(form, '#ctl0_MainModule_ItemsRemesacontenedor', { contenedor: numero, 'numero bl': input.bl })) {
    const required = ['contenedor_numero', 'naviera_codigo', 'tipcon_codigo', 'contenedor_tara', 'lugar_codigo$IDHidden', 'itemremesacontenedor_IteremconNumerobl'];
    throw new ApiError('CONTAINER_NOT_ADDED', 'Silogtran no agregó el contenedor.', {
      status: 502,
      detail: `vacíos=${required.filter((n) => !form.fields[P + n]).join(',') || 'ninguno'}`,
    });
  }
  return { numero: pick.attrs[attr], bl: input.bl };
}
