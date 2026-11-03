// Pure helpers for the admin report (easy to test): date ranges, KPIs and CSV.
export const BOGOTA_OFFSET = '-05:00'; // Colombia has no DST

// "YYYY-MM-DD" (Bogota calendar days) -> ISO instants [from, to).
export function rangeToIso(desde, hasta) {
  const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !Number.isNaN(new Date(`${d}T00:00:00${BOGOTA_OFFSET}`).getTime());
  const out = {};
  if (ok(desde)) out.from = new Date(`${desde}T00:00:00${BOGOTA_OFFSET}`).toISOString();
  if (ok(hasta)) out.to = new Date(new Date(`${hasta}T00:00:00${BOGOTA_OFFSET}`).getTime() + 86_400_000).toISOString();
  return out;
}

export function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const i = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[i];
}

const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

// rows: [{ estado, totalMs, saveMs, prepareMs, migrado, manifiesto }]
export function buildKpis(rows) {
  const done = rows.filter((r) => r.estado === 'DONE');
  const total = rows.filter((r) => r.estado !== 'PROCESSING');
  const t = done.map((r) => r.totalMs).filter(Number.isFinite).sort((a, b) => a - b);
  const sv = done.map((r) => r.saveMs).filter(Number.isFinite);
  const pr = done.map((r) => r.prepareMs).filter(Number.isFinite);
  return {
    intentos: total.length,
    exitosos: done.length,
    fallidos: rows.filter((r) => r.estado === 'FAILED').length,
    inciertos: rows.filter((r) => r.estado === 'UNKNOWN').length,
    exitoPct: total.length ? Math.round((done.length / total.length) * 1000) / 10 : null,
    totalMs: { promedio: avg(t), p50: percentile(t, 50), p90: percentile(t, 90), max: t.length ? t[t.length - 1] : null },
    prepararMsPromedio: avg(pr),
    grabarMsPromedio: avg(sv),
    migrados: done.filter((r) => r.migrado === true).length,
    sinMigrar: done.filter((r) => r.migrado !== true && r.manifiesto).length,
  };
}

// CSV with formula-injection protection (cells starting with = + - @ are prefixed with a quote).
const cell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (headers, rows) => '﻿' + [headers.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n') + '\r\n';
