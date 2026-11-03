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

function text(v, label, fallback) {
  const s = String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim();
  if (s.length > 300) throw bad(`${label} es demasiado largo (máximo 300 caracteres).`);
  return s || fallback;
}

export function parsePreparar(body) {
  const b = body && typeof body === 'object' ? body : {};
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
    ordenCompra: text(b.ordenCompra, 'ordenCompra', 'NA'),
    observacionOrdenCargue: text(b.observacionOrdenCargue, 'observacionOrdenCargue', 'NA'),
    observacionRemesa: text(b.observacionRemesa, 'observacionRemesa', 'NA'),
    contenedor: b.contenedor == null ? null : text(b.contenedor, 'contenedor', null),
    bl: b.bl == null ? null : text(b.bl, 'bl', null),
  };
}
