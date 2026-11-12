// Tools of the activation MCP. Spanish text for the person, fixed error codes for the client.
// A plate involves several "entes" that must ALL be active to dispatch: the vehicle, its trailer and its conductor / propietario / poseedor
// (the same person can hold several roles). `revisar_vehiculo` reports them all; `activar_vehiculo` activates ONLY what the person chose.
import { ApiError } from '../http/errors.js';
import { withLock } from '../store/locks.js';
import { assertActorActive, openActorSession, resolveActorId, sessionKey } from '../silogtran/userSession.js';
import { activateVehicle, activateTrailer } from '../silogtran/activar.js';
import { searchThirdPartyItems, activateThirdParty } from '../silogtran/terceros.js';
import { reviewVehicle, activateEntities, chosenEntes, reviewText, activationText, ACTIVABLE_ENTES } from '../silogtran/entes.js';
import { logActivation } from '../store/activaciones.js';
import { getUser } from '../store/usuarios.js';

const PLACA = { type: 'string', description: 'Placa del vehículo (letras y números, sin espacios), por ejemplo "ABC123".', minLength: 4, maxLength: 10 };
const DOCUMENTO = { type: 'string', description: 'Número de documento (cédula o NIT) del tercero, solo dígitos.', minLength: 5, maxLength: 20 };
const ID = { type: 'string', description: 'Id interno del tercero en Silogtran (solo si una consulta anterior devolvió varios candidatos).', maxLength: 12 };

export const TOOLS = [
  {
    name: 'revisar_vehiculo',
    description: 'Revisa en Silogtran TODO lo que debe estar activo para despachar una placa: el vehículo, su trailer y los terceros conductor, propietario y poseedor (pueden ser la misma persona o distintas). Muestra el nombre y el estado (ACTIVO/INACTIVO) de cada uno. Solo lectura. Llámala SIEMPRE primero, muestra el resultado completo a la persona y pregúntale qué quiere activar.',
    inputSchema: { type: 'object', properties: { placa: PLACA }, required: ['placa'], additionalProperties: false },
    annotations: { title: 'Revisar vehículo y sus entes', readOnlyHint: true, openWorldHint: true },
    scope: 'activar',
  },
  {
    name: 'activar_vehiculo',
    description: `ACTIVA en Silogtran lo que la persona pidió de una placa. Sin \`entes\`, activa SOLO la placa (el vehículo). Con \`entes\` activa exactamente esos, uno o varios: ${ACTIVABLE_ENTES.join(', ')} o todos (ej.: ["conductor"] para activar solo el conductor; ["trailer","poseedor"]; ["todos"]). Si la persona pidió «la placa y sus entes» o no está claro qué quiere, llama antes a revisar_vehiculo, muéstrale el estado de cada ente y pregúntale. Orden: terceros (una sola vez por persona aunque tenga varios roles), luego el trailer y al final la placa. Los que ya están activos no se tocan. Si Silogtran exige imágenes/documentos que faltan, ese ente no se activa y se listan los faltantes.`,
    inputSchema: {
      type: 'object',
      properties: { placa: PLACA, entes: { type: 'array', description: 'Qué activar (uno o varios), según lo que pidió la persona. Si se omite, solo la placa.', items: { type: 'string', enum: [...ACTIVABLE_ENTES, 'todos'] }, minItems: 1, maxItems: 5 } },
      required: ['placa'], additionalProperties: false,
    },
    annotations: { title: 'Activar entes de una placa', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    scope: 'activar',
  },
  {
    name: 'consultar_tercero',
    description: 'Consulta en Silogtran el estado (ACTIVO/INACTIVO) de un tercero por su documento (cédula o NIT). Si el documento tiene varios candidatos devuelve la lista para elegir. Solo lectura.',
    inputSchema: { type: 'object', properties: { documento: DOCUMENTO, id: ID }, required: ['documento'], additionalProperties: false },
    annotations: { title: 'Consultar tercero', readOnlyHint: true, openWorldHint: true },
    scope: 'activar',
  },
  {
    name: 'activar_tercero',
    description: 'ACTIVA en Silogtran un tercero (persona o empresa) por su documento, si está INACTIVO. Confirma con la persona el documento antes. Si hay varios candidatos no activa nada y los lista. Si faltan imágenes/documentos, no se activa y se listan.',
    inputSchema: { type: 'object', properties: { documento: DOCUMENTO, id: ID }, required: ['documento'], additionalProperties: false },
    annotations: { title: 'Activar tercero', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    scope: 'activar',
  },
];

const text = (t, extra = {}) => ({ content: [{ type: 'text', text: t }], ...extra });
const fail = (code, message, extra = {}) => ({ content: [{ type: 'text', text: message }], isError: true, structuredContent: { ok: false, code, message, ...extra } });

// Runs `fn(client)` on the Silogtran session of whoever is calling, under the session lock:
//   - a PERSON (principal.kind 'user'): their own session, so Silogtran records THEIR user for the action;
//   - the admin key: MCP_ACTOR (id / Silogtran user; empty = user zero).
// Returns { out, actor, userId, conexionId } where `actor` is the label for the audit.
async function withSilogtran(principal, fn) {
  const person = principal?.kind === 'user';
  const userId = person ? principal.uid : await resolveActorId(process.env.MCP_ACTOR);
  await assertActorActive(userId);
  const out = await withLock(sessionKey(userId), async () => {
    const { client } = await openActorSession(userId);
    return client.enqueue(() => fn(client));
  });
  let actor = 'admin (usuario cero)';
  if (userId) actor = (await getUser(userId).catch(() => null))?.silog_user || String(userId);
  return { out, actor, userId, conexionId: person ? principal.mc : null };
}

const validPlate = (v) => {
  const p = String(v ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,10}$/.test(p)) throw new ApiError('INVALID_PARAMETER', 'La placa debe tener entre 4 y 10 letras o números, sin espacios ni símbolos.', { status: 400 });
  return p;
};
const validDoc = (v) => {
  const d = String(v ?? '').replace(/\D/g, '');
  if (d.length < 5 || d.length > 15) throw new ApiError('INVALID_PARAMETER', 'El documento debe tener entre 5 y 15 dígitos.', { status: 400 });
  return d;
};

const realDeps = { withSilogtran, logActivation, review: reviewVehicle, activateEntities, activateVehicle, activateTrailer, activateThirdParty, searchThirdPartyItems };
const REFUSED = ['ACTIVATE_NOT_ALLOWED', 'VEHICLE_ANNULLED', 'THIRD_PARTY_ANNULLED', 'PLATE_NOT_FOUND', 'THIRD_PARTY_NOT_FOUND', 'AMBIGUOUS_OPTION', 'ROW_STATE_UNKNOWN', 'INVALID_PARAMETER'];

// Old tool names still called by clients that cached the first tool list (ChatGPT does not refresh it by itself).
const ALIASES = { consultar_vehiculo: 'revisar_vehiculo' };

export async function callTool(name, args = {}, deps = realDeps, principal = { kind: 'admin' }) {
  const t0 = Date.now();
  name = ALIASES[name] ?? name;
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new ApiError('UNKNOWN_TOOL', `No existe la herramienta ${String(name).slice(0, 40)}.`, { status: 404 });
  if (principal.kind === 'user' && principal.scope !== tool.scope) return fail('SCOPE_DENIED', 'Tu acceso no incluye esta herramienta.');
  const who = { user_id: principal.kind === 'user' ? principal.uid : null, conexion_id: principal.kind === 'user' ? principal.mc : null };
  const audit = (row) => deps.logActivation({ actor: principal.kind === 'user' ? String(principal.uid) : 'admin (usuario cero)', ...who, ms: Date.now() - t0, ...row });

  if (name === 'revisar_vehiculo') {
    try {
      const placa = validPlate(args.placa);
      const { out } = await deps.withSilogtran(principal, (client) => deps.review(client, placa));
      return text(reviewText(out), { structuredContent: { ok: true, ...out } });
    } catch (e) {
      return errorResult(e);
    }
  }

  if (name === 'activar_vehiculo') {
    let placa = String(args.placa ?? '').toUpperCase();
    try {
      placa = validPlate(args.placa);
      const defaulted = args.entes === undefined || args.entes === null; // old clients only send `placa`: activate just the plate
      const entes = defaulted ? ['placa'] : args.entes;
      chosenEntes(entes); // fail fast with clear guidance, before opening a Silogtran session
      const r = await deps.withSilogtran(principal, (client) => (deps.activateEntities ?? activateEntities)(client, placa, entes, { review: deps.review, activateThirdParty: deps.activateThirdParty, activateTrailer: deps.activateTrailer ?? activateTrailer, activateVehicle: deps.activateVehicle }));
      const { results, notes } = r.out;
      for (const x of results) {
        await audit({ tipo: { Placa: 'vehiculo', Trailer: 'trailer' }[x.etiqueta] ?? 'tercero', referencia: x.etiqueta === 'Placa' ? placa : `${placa}:${x.etiqueta}`, actor: r.actor,
          resultado: { ACTIVADO: 'ACTIVATED', YA_ACTIVO: 'ALREADY_ACTIVE', RECHAZADO: 'REFUSED', PENDIENTE: 'PENDING' }[x.resultado] ?? 'ERROR', error_code: x.codigo, detalle: x.detalle });
      }
      if (defaulted) {
        const left = (r.out.review?.inactivos ?? []).filter((x) => x.ente !== 'placa');
        if (left.length) notes.push(`Solo activé lo pedido (la placa). Siguen sin activar: ${left.map((x) => `${x.ente} ${x.nombre} (${x.estado ?? 'sin dato'})`).join('; ')}. Para activarlos, pídelo indicando cuáles (por ejemplo «activa el conductor» o «activa todos los entes»).`);
      }
      const failed = results.some((x) => x.resultado === 'ERROR');
      return text(activationText(placa, results, notes), { ...(failed ? { isError: true } : {}), structuredContent: { ok: !failed, placa, resultados: results.map(({ etiqueta, nombre, resultado, codigo, detalle, faltantes }) => ({ ente: etiqueta, nombre, resultado, codigo, detalle, faltantes })) } });
    } catch (e) {
      await audit({ tipo: 'vehiculo', referencia: placa, resultado: REFUSED.includes(e?.code) ? 'REFUSED' : 'ERROR', error_code: e?.code || 'ERROR', detalle: e?.detail });
      return errorResult(e);
    }
  }

  if (name === 'consultar_tercero' || name === 'activar_tercero') {
    let doc = String(args.documento ?? '');
    try {
      doc = validDoc(args.documento);
      const ref = { documento: doc, id: args.id ? String(args.id) : null };
      if (name === 'consultar_tercero') {
        const { out } = await deps.withSilogtran(principal, (client) => deps.searchThirdPartyItems(client, ref));
        const rows = ref.id ? out.rows.filter((r) => String(r.item) === ref.id) : out.rows;
        if (rows.length !== 1) return fail('AMBIGUOUS_OPTION', `Hay ${rows.length} filas para ese tercero; no puedo decir su estado con certeza.`);
        return text(`${rows[0].nombre} (${rows[0].tipo} ${rows[0].documento}): ${rows[0].estado}.`, { structuredContent: { ok: true, id: rows[0].item, nombre: rows[0].nombre, estado: rows[0].estado } });
      }
      const r = await deps.withSilogtran(principal, (client) => deps.activateThirdParty(client, ref));
      const d = r.out;
      await audit({ tipo: 'tercero', referencia: `doc:${doc}`, actor: r.actor, resultado: d.changed ? 'ACTIVATED' : 'ALREADY_ACTIVE' });
      return text(d.changed ? `✅ ${d.persona} quedó ACTIVO${d.verified ? ' (verificado)' : ' (no pude verificarlo; revisa en Silogtran)'}.` : `${d.persona} ya estaba ACTIVO; no hice ningún cambio.`, { structuredContent: { ok: true, nombre: d.persona, changed: d.changed, verified: d.verified } });
    } catch (e) {
      if (name === 'activar_tercero') await audit({ tipo: 'tercero', referencia: `doc:${doc}`, resultado: REFUSED.includes(e?.code) ? 'REFUSED' : 'ERROR', error_code: e?.code || 'ERROR', detalle: e?.extra?.faltantes?.join(', ') || e?.detail });
      if (name === 'consultar_tercero' && e?.code === 'THIRD_PARTY_NOT_FOUND') return text(`No encontré un tercero con el documento ${doc} en Silogtran.`, { structuredContent: { ok: true, existe: false } });
      return errorResult(e);
    }
  }
  throw new ApiError('UNKNOWN_TOOL', `No existe la herramienta ${String(name).slice(0, 40)}.`, { status: 404 });
}

// Known errors keep their Spanish message; anything unexpected becomes a generic one (no internals leak to the client).
export function errorResult(e) {
  if (e instanceof ApiError) {
    console.error('[mcp] tool error:', e.code); // code only: known errors were invisible in the logs
    return fail(e.code, e.message, { ...(e.extra?.faltantes ? { faltantes: e.extra.faltantes } : {}), ...(e.extra?.candidatos ? { candidatos: e.extra.candidatos } : {}) });
  }
  console.error('[mcp] tool failed:', e?.code || e?.name || 'error');
  return fail('INTERNAL_ERROR', 'Error interno al hablar con Silogtran; intenta de nuevo en un momento.');
}
