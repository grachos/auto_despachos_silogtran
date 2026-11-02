// Uniform API errors: fixed `code` for the LLM consumer + Spanish `message`.
export class ApiError extends Error {
  constructor(code, message, { status = 400, detail, extra } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.detail = detail;
    this.extra = extra;
  }
}

// Spanish messages for errors raised inside the Silogtran client (English internal messages go to `detail`).
const SILOG_MESSAGES = {
  SILOGTRAN_UNREACHABLE: 'No fue posible conectarse con Silogtran.',
  WAF_FAILED: 'No se pudo superar la protección AWS WAF de Silogtran.',
  LOGIN_FAILED: 'No se pudo iniciar sesión en Silogtran.',
  COST_CENTER_FAILED: 'No se pudo seleccionar el centro de costo en Silogtran.',
  SILOGTRAN_ERROR: 'Silogtran respondió con un error inesperado.',
};

export function toApiError(e) {
  if (e instanceof ApiError) return e;
  if (e?.name === 'SilogtranError') {
    return new ApiError(e.code, SILOG_MESSAGES[e.code] || SILOG_MESSAGES.SILOGTRAN_ERROR, {
      status: e.status || 502,
      detail: e.message,
    });
  }
  return new ApiError('INTERNAL_ERROR', 'Error interno del servicio.', { status: 500, detail: e?.message || String(e) });
}

export function sendError(res, e) {
  const err = toApiError(e);
  if (err.status >= 500) console.error(`[${err.code}]`, err.detail || err.message);
  res.status(err.status).json({ ok: false, code: err.code, message: err.message, detail: err.detail, ...err.extra });
}
