// Input validation for `preparar` (runs before touching Silogtran).
import { ApiError } from './http/errors.js';

const bad = (msg) => new ApiError('INVALID_PARAMETER', msg, { status: 400 });

function date(v, label) {
  const s = String(v ?? '').trim();
  const d = new Date(`${s}T00:00:00Z`);
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
  if (!ok) throw bad(`${label}: la fecha debe tener formato yyyy-MM-dd y ser válida.`);
  return s;
}

function time(v, label) {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(v ?? '').trim());
  if (!m || +m[1] > 23 || +m[2] > 59 || +(m[3] ?? 0) > 59) throw bad(`${label}: la hora debe tener formato HH:mm o HH:mm:ss.`);
  return `${m[1]}:${m[2]}:${m[3] ?? '00'}`;
}

function cita(v, label) {
  if (!v || typeof v !== 'object') throw bad(`Falta ${label} { fecha, hora }.`);
  return { fecha: date(v.fecha, `${label}.fecha`), hora: time(v.hora, `${label}.hora`) };
}

// Agreed loading/unloading time (hours + minutes). Default 2 h 0 min, which is what was always sent before.
function duration(v, label) {
  if (v == null) return { horas: 2, minutos: 0 };
  if (typeof v !== 'object') throw bad(`${label} debe ser { horas, minutos }.`);
  const h = Number(v.horas ?? 0);
  const m = Number(v.minutos ?? 0);
  if (!Number.isInteger(h) || h < 0 || h > 99 || !Number.isInteger(m) || m < 0 || m > 59 || h * 60 + m === 0) {
    throw bad(`${label}: horas entre 0 y 99 y minutos entre 0 y 59 (no ambos en cero).`);
  }
  return { horas: h, minutos: m };
}

function text(v, label, fallback) {
  const s = String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim();
  if (s.length > 300) throw bad(`${label} es demasiado largo (máximo 300 caracteres).`);
  return s || fallback;
}

// Where the vehicle is loaded from: "Vehículos Activos" (default) or the "Empresas" tab. Chosen by the person, never inferred.
function parseFuente(v) {
  if (v == null || String(v).trim() === '') return 'activos';
  const s = String(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  if (/^(activos?|vehiculos? activos?)$/.test(s)) return 'activos';
  if (/^(empresas?|pestana empresas?)$/.test(s)) return 'empresas';
  throw bad('El campo fuente debe ser "activos" (Vehículos Activos) o "empresas" (pestaña Empresas).');
}

// Words that name a RNDC manifest type («Despacho urbano», «viaje municipal»), never an operation type. A caller (usually the model) that
// puts one in tipoOperacion while leaving tipoManifiesto empty meant the manifest type: move it. An explicit tipoManifiesto always wins.
const MANIFEST_WORDS = /^(?:(?:despacho|viaje|manifiesto)\s+)?(?:urbano|urbana|municipal|municipales|urbano o municipal|municipal o urbano|general|multiparada|ida y regreso|viaje vacio|vacio|varios viajes(?: en el dia| municipales)?)$/;
const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

export function parsePreparar(body) {
  const b = { ...(body && typeof body === 'object' ? body : {}) };
  if ((b.tipoManifiesto == null || String(b.tipoManifiesto).trim() === '') && b.tipoOperacion != null && MANIFEST_WORDS.test(norm(b.tipoOperacion))) {
    b.tipoManifiesto = b.tipoOperacion;
    b.tipoOperacion = null;
  }
  const placa = text(b.placa, 'placa', '').toUpperCase();
  if (!placa) throw bad('Falta la placa del vehículo.');
  const item = b.item == null ? null : Number(b.item);
  if (item !== null && !Number.isInteger(item)) throw bad('El campo item debe ser un número entero.');
  return {
    item,
    placa,
    citaCargue: cita(b.citaCargue, 'citaCargue'),
    citaDescargue: cita(b.citaDescargue, 'citaDescargue'),
    tipoManifiesto: b.tipoManifiesto == null ? null : text(b.tipoManifiesto, 'tipoManifiesto', null),
    tipoOperacion: b.tipoOperacion == null || String(b.tipoOperacion).trim() === '' ? null : text(b.tipoOperacion, 'tipoOperacion', null),
    fuente: parseFuente(b.fuente),
    tiempoCargue: duration(b.tiempoCargue, 'tiempoCargue'),
    tiempoDescargue: duration(b.tiempoDescargue, 'tiempoDescargue'),
    ordenCompra: text(b.ordenCompra, 'ordenCompra', 'NA'),
    observacionOrdenCargue: text(b.observacionOrdenCargue, 'observacionOrdenCargue', 'NA'),
    observacionRemesa: text(b.observacionRemesa, 'observacionRemesa', 'NA'),
    contenedor: b.contenedor == null ? null : text(b.contenedor, 'contenedor', null),
    bl: b.bl == null ? null : text(b.bl, 'bl', null),
  };
}
