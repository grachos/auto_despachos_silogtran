// «Enviar Ministerio» for a manifest that did not get its filing number (radicado): used by the WhatsApp button and the MCP tool.
// Safety: only the OWNER's manifests (checked in our own dispatch table), only Vehículos Activos trips (Empresas are not reported to the
// Ministry), at most MAX_RESENDS resends per manifest, never pressed when a radicado already exists, one session lock for the whole call.
// Flow: press the button + follow the vendor's Ministry web service (silogtran/ministerio.js) -> re-read the manifest a few times ->
// if the radicado is there: save it and generate the PDF again (it now carries the QR code).
import { ApiError } from '../http/errors.js';
import { withLock } from '../store/locks.js';
import { assertActorActive, openActorSession, sessionKey } from '../silogtran/userSession.js';
import { sendToMinistry } from '../silogtran/ministerio.js';
import { readRndc } from '../silogtran/grabar.js';
import { getManifestPdfUrl } from '../silogtran/imprimir.js';
import { findDispatchByManifest, bumpMinistryRetry, saveRndc } from '../store/admin.js';

export const MAX_RESENDS = 3;
const SOFT_BUDGET_MS = 40_000; // after this, no more readings / PDF (Vercel kills the function at 60 s)

const cut = (t, n) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// Safe digest of the Ministry's plain-text report: one entry per «Informacion de Envio de <section>», personal document numbers masked,
// long numbers in error messages masked. Success lines (REGISTRO INGRESADO) are counted, other messages are reported as errors.
export function summarizeMinistryReport(text) {
  const t = String(text ?? '').replace(/(Documento\s*:\s*)\d+/gi, '$1***');
  const parts = t.split(/Informacion de Envio de\s+/i).slice(1);
  const secciones = parts.map((p) => {
    const nombre = cut(p.split(/\s+/)[0], 40);
    const msgs = [...p.matchAll(/Informacion\s*:\s*(.+?)(?=\s+Xml\b|\s+Documento\s*:|\s+Codigo\s*:|$)/gi)].map((m) => cut(m[1], 200));
    const ok = msgs.filter((m) => /REGISTRO INGRESADO/i.test(m)).length;
    const errores = msgs.filter((m) => !/REGISTRO INGRESADO/i.test(m)).map((m) => m.replace(/\b\d{7,}\b/g, '***')).slice(0, 5);
    if (!msgs.length && /No hay Informacion para Enviar/i.test(p)) return { nombre, estado: 'SIN_INFORMACION' };
    if (errores.length) return { nombre, estado: 'ERROR', ok, errores };
    if (msgs.length) return { nombre, estado: 'OK', ok };
    return { nombre, estado: 'OTRO', crudo: cut(p, 300).replace(/\b\d{7,}\b/g, '***') }; // unknown layout: show a masked excerpt
  });
  return { secciones, huboErrores: secciones.some((s) => s.estado === 'ERROR') };
}

export function resendText(r) {
  const left = r.intentosRestantes;
  if (r.estado === 'RADICADO') {
    const lines = [r.yaTeniaRadicado ? `✅ El manifiesto ${r.manifiesto} ya tenía radicado del Ministerio: ${r.radicado}.` : `✅ Reenviado: el Ministerio recibió el manifiesto ${r.manifiesto}. Radicado: ${r.radicado}${r.fechaHora ? ` (${r.fechaHora})` : ''}.`];
    if (r.pdf) lines.push(`📄 Manifiesto en PDF (con el código QR): ${r.pdf}`);
    return lines.join('\n');
  }
  const errs = (r.informe?.secciones ?? []).filter((s) => s.estado === 'ERROR').flatMap((s) => s.errores.map((e) => `• ${s.nombre}: ${e}`)).slice(0, 5);
  return [`⚠️ Reenvié el manifiesto ${r.manifiesto} al Ministerio, pero todavía no devuelve radicado.`, ...(errs.length ? ['El Ministerio informa:', ...errs] : ['Puede tardar un poco: consulta el estado en un momento.']), `Reenvíos que quedan: ${left}.`].join('\n');
}

const real = { assertActorActive, withLock, sessionKey, openActorSession, sendToMinistry, readRndc, getManifestPdfUrl, findDispatchByManifest, bumpMinistryRetry, saveRndc, now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export async function resendToMinistry(userId, rawManifiesto, deps = real) {
  const m = String(rawManifiesto ?? '').trim();
  if (!/^\d{3,20}$/.test(m)) throw new ApiError('INVALID_PARAMETER', 'El número de manifiesto debe contener solo dígitos.', { status: 400 });
  await deps.assertActorActive(userId);
  const row = await deps.findDispatchByManifest(m);
  // Same answer for «does not exist» and «is someone else's»: never reveal other people's manifests.
  if (!row || (row.user_id ?? null) !== (userId ?? null)) throw new ApiError('MANIFEST_NOT_FOUND', 'No encontré ese manifiesto entre tus despachos.', { status: 404 });
  if (row.fuente === 'empresas') throw new ApiError('MINISTRY_NOT_APPLICABLE', 'Los viajes cargados por la pestaña Empresas no se reportan al Ministerio.', { status: 409 });
  const used = row.ministerio_reintentos ?? 0;
  if (row.radicado) return { ok: true, manifiesto: m, estado: 'RADICADO', yaTeniaRadicado: true, radicado: row.radicado, fechaHora: null, pdf: null, intentosRestantes: Math.max(0, MAX_RESENDS - used) };
  if (used >= MAX_RESENDS) throw new ApiError('RESEND_LIMIT', `Ese manifiesto ya se reenvió ${MAX_RESENDS} veces desde aquí. Revisa las causas en Silogtran.`, { status: 429 });

  return deps.withLock(deps.sessionKey(userId), async () => {
    const { client } = await deps.openActorSession(userId);
    return client.enqueue(async () => {
      const t0 = deps.now();
      const sent = await deps.sendToMinistry(client, m, { timeoutSec: 20, ministryTimeoutSec: 35, textMax: 4000 });
      if (sent.skipped === 'ALREADY_MIGRATED') { // the Ministry already answered before our own record knew it
        await deps.saveRndc(row.token_id, sent.rndc).catch(() => {});
        return { ok: true, manifiesto: m, estado: 'RADICADO', yaTeniaRadicado: true, radicado: sent.rndc.radicado, fechaHora: sent.rndc.fechaHora ?? null, pdf: null, intentosRestantes: Math.max(0, MAX_RESENDS - used) };
      }
      if (!sent.ministry) throw new ApiError('MINISTRY_NO_HANDOFF', 'Silogtran no entregó la dirección del servicio del Ministerio; no se pudo reenviar.', { status: 502 });
      await deps.bumpMinistryRetry(row.token_id, used).catch(() => {}); // counted only once the Ministry service was actually called
      const informe = summarizeMinistryReport(sent.ministry.texto);
      let rndc = null;
      for (let i = 0; i < 3; i++) {
        rndc = await deps.readRndc(client, m).catch(() => null);
        if (rndc?.migrated || deps.now() - t0 > SOFT_BUDGET_MS) break;
        await deps.sleep(4000);
      }
      let pdf = null;
      if (rndc?.migrated) {
        await deps.saveRndc(row.token_id, rndc).catch(() => {});
        if (deps.now() - t0 < SOFT_BUDGET_MS) pdf = await deps.getManifestPdfUrl(client, m);
      }
      return {
        ok: true, manifiesto: m, estado: rndc?.migrated ? 'RADICADO' : 'SIN_RADICADO', yaTeniaRadicado: false,
        radicado: rndc?.radicado ?? null, fechaHora: rndc?.fechaHora ?? null, pdf, informe,
        intentosRestantes: Math.max(0, MAX_RESENDS - used - 1), ms: deps.now() - t0,
      };
    });
  });
}
