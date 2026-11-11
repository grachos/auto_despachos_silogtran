// Tools of the activation MCP. Spanish text for the person, fixed error codes for the client. Vehicles only for now (third parties later).
import { ApiError } from '../http/errors.js';
import { withLock } from '../store/locks.js';
import { assertActorActive, openActorSession, resolveActorId, sessionKey } from '../silogtran/userSession.js';
import { searchVehicleItems, activateVehicle } from '../silogtran/activar.js';
import { logActivation } from '../store/activaciones.js';

const PLACA = { type: 'string', description: 'Placa del vehículo (letras y números, sin espacios), por ejemplo "ABC123".', minLength: 4, maxLength: 10 };

export const TOOLS = [
  {
    name: 'consultar_vehiculo',
    description: 'Consulta en Silogtran el estado de un vehículo por su placa (ACTIVO, INACTIVO o ANULADO). Solo lectura: no cambia nada.',
    inputSchema: { type: 'object', properties: { placa: PLACA }, required: ['placa'], additionalProperties: false },
    annotations: { title: 'Consultar vehículo', readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'activar_vehiculo',
    description: 'ACTIVA en Silogtran el vehículo con esa placa si está INACTIVO. Si ya estaba activo no hace nada. Si Silogtran exige imágenes/documentos que faltan, no se activa y se listan los faltantes. No activa vehículos ANULADOS. Confirma con la persona la placa antes de llamarla.',
    inputSchema: { type: 'object', properties: { placa: PLACA }, required: ['placa'], additionalProperties: false },
    annotations: { title: 'Activar vehículo', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

const text = (t, extra = {}) => ({ content: [{ type: 'text', text: t }], ...extra });
const fail = (code, message, extra = {}) => ({ content: [{ type: 'text', text: message }], isError: true, structuredContent: { ok: false, code, message, ...extra } });

// Runs `fn(client)` on the Silogtran session of the configured actor (MCP_ACTOR = user id / Silogtran user; empty = user zero), under the session lock.
async function withSilogtran(fn) {
  const userId = await resolveActorId(process.env.MCP_ACTOR);
  await assertActorActive(userId);
  return withLock(sessionKey(userId), async () => {
    const { client } = await openActorSession(userId);
    return client.enqueue(() => fn(client));
  }).then((out) => ({ out, actor: userId ?? 'default' }));
}

const validPlate = (v) => {
  const p = String(v ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,10}$/.test(p)) throw new ApiError('INVALID_PARAMETER', 'La placa debe tener entre 4 y 10 letras o números, sin espacios ni símbolos.', { status: 400 });
  return p;
};

export async function callTool(name, args = {}, deps = { withSilogtran, searchVehicleItems, activateVehicle, logActivation }) {
  const t0 = Date.now();
  if (name === 'consultar_vehiculo') {
    try {
      const placa = validPlate(args.placa);
      const { out } = await deps.withSilogtran((client) => deps.searchVehicleItems(client, placa).then((r) => r.rows));
      const rows = out.filter((r) => String(r.placa).toUpperCase() === placa);
      if (rows.length !== 1) return fail('AMBIGUOUS_OPTION', `Hay ${rows.length} filas para la placa ${placa}; no puedo decir su estado con certeza.`);
      return text(`La placa ${placa} está ${rows[0].estado}.`, { structuredContent: { ok: true, placa, estado: rows[0].estado } });
    } catch (e) {
      if (e?.code === 'PLATE_NOT_FOUND') return text(`No encontré la placa ${String(args.placa ?? '').toUpperCase()} en Silogtran.`, { structuredContent: { ok: true, existe: false } });
      return errorResult(e);
    }
  }
  if (name === 'activar_vehiculo') {
    let placa = String(args.placa ?? '').toUpperCase();
    let actor = 'default';
    try {
      placa = validPlate(args.placa);
      const r = await deps.withSilogtran((client) => deps.activateVehicle(client, placa));
      actor = r.actor;
      const done = r.out;
      await deps.logActivation({ tipo: 'vehiculo', referencia: placa, actor, resultado: done.changed ? 'ACTIVATED' : 'ALREADY_ACTIVE', ms: Date.now() - t0 });
      if (!done.changed) return text(`La placa ${placa} ya estaba ACTIVA; no hice ningún cambio.`, { structuredContent: { ok: true, placa, changed: false, estado: 'ACTIVO' } });
      return text(`✅ La placa ${placa} quedó ACTIVA en Silogtran${done.verified ? ' (verificado)' : ' (no pude verificarlo; revisa en Silogtran)'}.`, { structuredContent: { ok: true, placa, changed: true, verified: done.verified } });
    } catch (e) {
      const refused = ['ACTIVATE_NOT_ALLOWED', 'VEHICLE_ANNULLED', 'PLATE_NOT_FOUND', 'AMBIGUOUS_OPTION', 'ROW_STATE_UNKNOWN', 'INVALID_PARAMETER'].includes(e?.code);
      await deps.logActivation({ tipo: 'vehiculo', referencia: placa, actor, resultado: refused ? 'REFUSED' : 'ERROR', error_code: e?.code || 'ERROR', detalle: e?.extra?.faltantes?.join(', ') || e?.detail, ms: Date.now() - t0 });
      return errorResult(e);
    }
  }
  throw new ApiError('UNKNOWN_TOOL', `No existe la herramienta ${String(name).slice(0, 40)}.`, { status: 404 });
}

// Known errors keep their Spanish message; anything unexpected becomes a generic one (no internals leak to the client).
export function errorResult(e) {
  if (e instanceof ApiError) return fail(e.code, e.message, e.extra?.faltantes ? { faltantes: e.extra.faltantes } : {});
  console.error('[mcp] tool failed:', e?.code || e?.name || 'error');
  return fail('INTERNAL_ERROR', 'Error interno al hablar con Silogtran; intenta de nuevo en un momento.');
}
