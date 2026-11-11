// "Entes" of a plate: the vehicle, its trailer and its three third parties (conductor, propietario, poseedor) — everything that must be ACTIVE
// to dispatch. The vehicle sheet (`Maestros.Vehiculo.Home_111`) carries the ids and names; each ente's state comes from its own activation
// module (grid column `estado`). Any combination of persons is possible (the same person can hold several roles): the report always lists the
// three roles separately with name and state, but each distinct person is looked up (and, later, activated) ONCE, by id.
import * as cheerio from 'cheerio';
import { cell, norm } from './text.js';
import { fetchVehicleSheet } from './placa.js';
import { searchVehicleItems } from './activar.js';
import { searchThirdPartyItems } from './terceros.js';
import { ApiError } from '../http/errors.js';

const P = 'ctl0$MainModule$';
const ROLES = { conductor: 'tercero_codigo_conductor', propietario: 'tercero_codigo_propietario', poseedor: 'tercero_codigo_poseedor', trailer: 'trailer_codigo' };

// Pure: { conductor, propietario, poseedor, trailer } each { id, nombre } or null (empty field). Names are the text of the control; ids its `$IDHidden`.
export function parseVehicleEntities(html) {
  const $ = cheerio.load(String(html));
  const read = (base) => {
    const id = cell($(`[name="${P}${base}$IDHidden"]`).attr('value'));
    const nombre = cell($(`[name="${P}${base}"]`).attr('value'));
    return id || nombre ? { id: id || null, nombre } : null;
  };
  return Object.fromEntries(Object.entries(ROLES).map(([role, base]) => [role, read(base)]));
}

const estadoOf = (rows, id) => {
  const r = id ? rows.find((x) => String(x.item) === String(id)) : null;
  return r ? String(r.estado).toUpperCase() || null : null;
};

// Read-only review of everything a dispatch needs. Runs inside client.enqueue().
// Returns { placa, vehiculo:{estado}, entes:{conductor,propietario,poseedor,trailer}, listoParaDespachar, inactivos[] }.
// The trailer state is NOT verified yet (its module is not mapped): estado 'NO_VERIFICADO' and it never blocks `listoParaDespachar` on its own.
export async function reviewVehicle(client, placa, deps = { fetchVehicleSheet, searchVehicleItems, searchThirdPartyItems }) {
  const plate = String(placa ?? '').trim().toUpperCase();
  const sheet = await deps.fetchVehicleSheet(client, plate);
  if (!sheet) throw new ApiError('PLATE_NOT_FOUND', `No encontré la placa ${plate} en Silogtran.`, { status: 404 });
  const ents = parseVehicleEntities(sheet.text);
  const { rows } = await deps.searchVehicleItems(client, plate);
  const vrow = rows.find((r) => norm(r.placa) === norm(plate));
  const vehiculo = { placa: plate, estado: vrow ? String(vrow.estado).toUpperCase() : null };

  const states = new Map(); // one lookup per DISTINCT person
  for (const role of ['conductor', 'propietario', 'poseedor']) {
    const e = ents[role];
    if (!e?.id || states.has(e.id)) continue;
    try {
      const { rows: trows } = await deps.searchThirdPartyItems(client, { id: e.id, documento: e.nombre });
      states.set(e.id, estadoOf(trows, e.id));
    } catch (err) {
      console.error('[entes] third party lookup failed:', err?.code || err?.name || 'error');
      states.set(e.id, null);
    }
  }
  const entes = {};
  for (const role of ['conductor', 'propietario', 'poseedor']) {
    const e = ents[role];
    entes[role] = e ? { id: e.id, nombre: e.nombre, estado: e.id ? (states.get(e.id) ?? null) : null } : null;
  }
  entes.trailer = ents.trailer ? { id: ents.trailer.id, nombre: ents.trailer.nombre, estado: 'NO_VERIFICADO' } : null;

  const inactivos = [];
  if (vehiculo.estado !== 'ACTIVO') inactivos.push({ ente: 'placa', nombre: plate, estado: vehiculo.estado });
  for (const role of ['conductor', 'propietario', 'poseedor']) {
    const e = entes[role];
    if (e && e.estado !== 'ACTIVO') inactivos.push({ ente: role, nombre: e.nombre, estado: e.estado });
  }
  const sinDato = ['conductor', 'propietario', 'poseedor'].filter((r) => !entes[r]);
  return { placa: plate, vehiculo, entes, inactivos, sinDato, listoParaDespachar: inactivos.length === 0 && sinDato.length === 0 };
}

// ---------- text for the person (Spanish) ----------
const mark = (estado) => ({ ACTIVO: '✅', INACTIVO: '⛔', ANULADO: '🚫' }[estado] ?? '❔');
const label = (estado) => estado ?? 'no pude verificarlo';

export function reviewText(r) {
  const lines = [`Placa ${r.placa}: ${mark(r.vehiculo.estado)} ${label(r.vehiculo.estado)}`];
  if (r.entes.trailer) lines.push(`Trailer ${r.entes.trailer.nombre}: ❔ aún no puedo verificar su estado (revísalo en Silogtran)`);
  else lines.push('Trailer: no tiene');
  for (const [role, name] of [['conductor', 'Conductor'], ['propietario', 'Propietario'], ['poseedor', 'Poseedor']]) {
    const e = r.entes[role];
    lines.push(e ? `${name} ${e.nombre}: ${mark(e.estado)} ${label(e.estado)}` : `${name}: ❔ la ficha no lo trae`);
  }
  lines.push(r.listoParaDespachar
    ? '→ Todo activo (el trailer no se verificó): la placa quedaría lista para despachar.'
    : `→ Todavía NO se puede despachar. Falta activar: ${[...new Set(r.inactivos.map((i) => i.ente))].join(', ') || 'revisar datos faltantes'}.`);
  return lines.join('\n');
}

const OUTCOME = { ACTIVADO: ['✅', 'quedó activado'], YA_ACTIVO: ['➖', 'ya estaba activo'], RECHAZADO: ['❌', 'no se activó'], ERROR: ['⚠️', 'no pude activarlo'], PENDIENTE: ['⏳', 'quedó pendiente (tiempo agotado); vuelve a pedirlo'] };
export function activationText(placa, results, notes = []) {
  const lines = [`Resultado para la placa ${placa}:`];
  for (const x of results) {
    const [icon, text] = OUTCOME[x.resultado] ?? ['❔', x.resultado];
    lines.push(`${icon} ${x.etiqueta}${x.nombre ? ` ${x.nombre}` : ''}: ${text}${x.detalle ? ` — ${x.detalle}` : ''}`);
  }
  lines.push(...notes);
  return lines.join('\n');
}

// ---------- activation of the chosen entes ----------
export const ACTIVABLE_ENTES = ['placa', 'conductor', 'propietario', 'poseedor'];
const KNOWN_REFUSALS = ['ACTIVATE_NOT_ALLOWED', 'VEHICLE_ANNULLED', 'THIRD_PARTY_ANNULLED', 'PLATE_NOT_FOUND', 'THIRD_PARTY_NOT_FOUND', 'AMBIGUOUS_OPTION', 'ROW_STATE_UNKNOWN', 'ACTIVATE_NOT_APPLIED', 'ACTIVATE_CHECKBOX_MISSING'];

// Activates the chosen entes of a plate. ORDER: terceros (each distinct person ONCE) -> plate. The trailer is not supported yet (its module is not
// mapped). Each step is independent (a refusal does not stop the others) but a time budget protects Vercel's 60 s: what does not fit is PENDIENTE.
// `deps`: { review, activateThirdParty, activateVehicle }. Returns { results[], notes[], review }.
export async function activateEntities(client, placa, entes, deps, { budgetMs = 40_000, now = Date.now } = {}) {
  const t0 = now();
  const chosen = new Set((entes ?? []).includes('todos') ? ACTIVABLE_ENTES : entes);
  for (const e of chosen) if (!ACTIVABLE_ENTES.includes(e)) throw new ApiError('INVALID_PARAMETER', `Ente no válido: ${String(e).slice(0, 20)}. Usa: ${ACTIVABLE_ENTES.join(', ')} o todos.`, { status: 400 });
  if (!chosen.size) throw new ApiError('INVALID_PARAMETER', 'Indica qué activar: placa, conductor, propietario, poseedor o todos.', { status: 400 });
  const review = await deps.review(client, placa);

  // distinct persons among the chosen third-party roles
  const persons = new Map(); // id -> { id, nombre, estado, roles[] }
  for (const role of ['conductor', 'propietario', 'poseedor']) {
    const e = review.entes[role];
    if (!chosen.has(role) || !e?.id) continue;
    const p = persons.get(e.id) ?? { id: e.id, nombre: e.nombre, estado: e.estado, roles: [] };
    p.roles.push(role);
    persons.set(e.id, p);
  }
  const results = [];
  const notes = [];
  const tooLate = () => now() - t0 > budgetMs;
  const run = async (etiqueta, nombre, fn, already) => {
    if (already) return results.push({ etiqueta, nombre, resultado: 'YA_ACTIVO' });
    if (tooLate()) return results.push({ etiqueta, nombre, resultado: 'PENDIENTE' });
    try {
      const out = await fn();
      results.push({ etiqueta, nombre, resultado: out.changed ? 'ACTIVADO' : 'YA_ACTIVO', ...(out.changed && out.verified === false ? { detalle: 'no pude verificarlo; revisa en Silogtran' } : {}) });
    } catch (e) {
      if (e instanceof ApiError && KNOWN_REFUSALS.includes(e.code)) results.push({ etiqueta, nombre, resultado: 'RECHAZADO', codigo: e.code, detalle: e.extra?.faltantes?.length ? `faltan: ${e.extra.faltantes.join(', ')}` : e.message, faltantes: e.extra?.faltantes });
      else { console.error('[entes] activation failed:', e?.code || e?.name || 'error'); results.push({ etiqueta, nombre, resultado: 'ERROR', codigo: e?.code ?? 'ERROR' }); }
    }
  };
  for (const p of persons.values()) {
    const etiqueta = p.roles.map((r) => r[0].toUpperCase() + r.slice(1)).join('/');
    await run(etiqueta, p.nombre, () => deps.activateThirdParty(client, { id: p.id, documento: p.nombre }), p.estado === 'ACTIVO');
    results[results.length - 1].ids = p.id;
    // a person activated for one role is active for ALL their roles on this plate
    const others = ['conductor', 'propietario', 'poseedor'].filter((r) => !p.roles.includes(r) && review.entes[r]?.id === p.id);
    if (others.length) notes.push(`${p.nombre} figura también como ${others.join(' y ')}: se activa una sola vez por persona.`);
  }
  if (chosen.has('placa')) await run('Placa', placa, () => deps.activateVehicle(client, placa), review.vehiculo.estado === 'ACTIVO');
  if ((entes ?? []).includes('todos') && review.entes.trailer) notes.push('El trailer no se activó: ese módulo aún no está disponible por este medio (actívalo en Silogtran).');
  return { results, notes, review };
}
