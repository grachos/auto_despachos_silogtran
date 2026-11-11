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
