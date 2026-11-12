// GET /api/admin/reporte?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&usuario=<id|cero>&estado=DONE|FAILED|UNKNOWN[&format=csv]
// One row per dispatch attempt with documents, Ministry filing number and timings, plus KPIs.
import { sendError, ApiError } from '../../http/errors.js';
import { requireEnv } from '../../config.js';
import { requireAdmin } from '../../http/admin.js';
import { listDispatches } from '../../store/admin.js';
import { rangeToIso, buildKpis, toCsv } from '../../admin/report.js';

const ESTADOS = new Set(['DONE', 'FAILED', 'UNKNOWN']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fmt = (ms) => (ms === null || ms === undefined ? '' : (ms / 1000).toFixed(1));

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  try {
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET');
      return res.status(405).json({ ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' });
    }
    requireAdmin(req);
    requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_KEY');
    const q = req.query || {};
    if (q.estado && !ESTADOS.has(q.estado)) throw new ApiError('INVALID_PARAMETER', 'estado debe ser DONE, FAILED o UNKNOWN.', { status: 400 });
    if (q.usuario && q.usuario !== 'cero' && !UUID.test(q.usuario)) throw new ApiError('INVALID_PARAMETER', 'usuario inválido.', { status: 400 });
    const range = rangeToIso(q.desde, q.hasta);
    if (!range.from && !range.to && !q.desde && !q.hasta) range.from = new Date(Date.now() - 30 * 86_400_000).toISOString(); // default: last 30 days

    const filas = await listDispatches({ ...range, userId: q.usuario, estado: q.estado });
    if (q.format === 'csv') {
      const headers = ['Fecha (UTC)', 'Usuario', 'Origen', 'Solicitud', 'Item', 'Placa', 'Estado', 'Anticipo', 'Valor anticipo', 'Orden de cargue', 'Remesa', 'Manifiesto', 'Transferencia', 'Radicado', 'Fecha/hora Ministerio', 'Preparar (s)', 'Grabar (s)', 'Total (s)', 'Error'];
      const rows = filas.map((r) => [r.fecha, r.usuario ?? 'API (usuario cero)', r.origen, r.solicitud, r.item, r.placa, r.estado, r.anticipoModo, r.anticipoValor, r.ordenCargue, r.remesa, r.manifiesto, r.transferencia, r.radicado ?? (r.fuente === 'empresas' ? 'No aplica (Empresas)' : ''), r.rndcFechaHora, fmt(r.prepareMs), fmt(r.saveMs), fmt(r.totalMs), r.errorCode]);
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('content-disposition', 'attachment; filename="despachos.csv"');
      return res.status(200).send(toCsv(headers, rows));
    }
    res.status(200).json({ ok: true, kpis: buildKpis(filas), total: filas.length, truncado: filas.length >= 1000, filas });
  } catch (e) {
    sendError(res, e);
  }
}
