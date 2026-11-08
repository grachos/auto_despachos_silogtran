// Read models for the admin panel (Supabase, service key).
import { supabase } from './supabase.js';
import { ApiError } from '../http/errors.js';

const run = async (q) => {
  const { data, error } = await q;
  if (error) throw new ApiError('STORE_FAILED', 'No se pudo leer de Supabase.', { status: 500, detail: error.message });
  return data;
};
const maskPhone = (p) => (p ? `••••${String(p).slice(-4)}` : null);

export async function listUsers() {
  const db = supabase();
  const [users, links, disp] = await Promise.all([
    run(db.from('app_users').select('id, nombre, silog_user, status, relink_required, created_at').order('created_at')),
    run(db.from('vinculos_whatsapp').select('user_id, phone, linked_at')),
    run(db.from('silog_confirmaciones').select('user_id, status, created_at').not('user_id', 'is', null).limit(5000)),
  ]);
  const link = new Map(links.map((l) => [l.user_id, l]));
  return users.map((u) => {
    const mine = disp.filter((d) => d.user_id === u.id);
    const last = mine.reduce((m, d) => (d.created_at > m ? d.created_at : m), '');
    const l = link.get(u.id);
    return {
      id: u.id, nombre: u.nombre, silogUser: u.silog_user, estado: u.relink_required ? 'NEEDS_RELINK' : u.status, creadoEn: u.created_at,
      whatsapp: l ? 'VINCULADO' : 'DESVINCULADO', telefono: maskPhone(l?.phone), vinculadoDesde: l?.linked_at ?? null,
      despachos: mine.filter((d) => d.status === 'DONE').length, ultimoDespacho: last || null,
    };
  });
}

// Confirmations (one per attempt), newest first.
export async function listDispatches({ from, to, userId, estado, limit = 1000 } = {}) {
  let q = supabase().from('silog_confirmaciones').select(
    'token_id, numero, status, created_at, user_id, fuente, placa, solicitud_item, anticipo_modo, anticipo_valor, orden_cargue, remesa, manifiesto, transferencia, radicado, rndc_migrated, rndc_fecha_hora, rndc_checked_at, prepare_ms, save_ms, total_ms, error_code, app_users(nombre)',
  ).neq('status', 'PROCESSING').order('created_at', { ascending: false }).limit(limit);
  if (from) q = q.gte('created_at', from);
  if (to) q = q.lt('created_at', to);
  if (userId === 'cero') q = q.is('user_id', null);
  else if (userId) q = q.eq('user_id', userId);
  if (estado) q = q.eq('status', estado);
  return (await run(q)).map((r) => ({
    id: r.token_id, fecha: r.created_at, usuario: r.app_users?.nombre ?? null, userId: r.user_id, solicitud: r.numero, item: r.solicitud_item,
    fuente: r.fuente ?? 'activos', placa: r.placa, estado: r.status, anticipoModo: r.anticipo_modo, anticipoValor: r.anticipo_valor,
    ordenCargue: r.orden_cargue, remesa: r.remesa, manifiesto: r.manifiesto, transferencia: r.transferencia,
    radicado: r.radicado, migrado: r.rndc_migrated, rndcFechaHora: r.rndc_fecha_hora, rndcRevisado: r.rndc_checked_at,
    prepareMs: r.prepare_ms, saveMs: r.save_ms, totalMs: r.total_ms, errorCode: r.error_code,
  }));
}

// DONE dispatches whose manifest has no Ministry filing number yet (recent ones first).
export async function pendingRndc(limit = 10) {
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  return run(
    supabase().from('silog_confirmaciones').select('token_id, manifiesto').eq('status', 'DONE').not('manifiesto', 'is', null)
      .is('radicado', null).or('fuente.is.null,fuente.neq.empresas').gt('created_at', since).order('created_at', { ascending: false }).limit(limit),
  );
}

// Atomic "I will tell the person": true only for the first caller (the Ministry notice is sent exactly once per dispatch).
export async function claimRndcNotice(tokenId) {
  const rows = await run(supabase().from('silog_confirmaciones').update({ rndc_notified_at: new Date().toISOString() })
    .eq('token_id', tokenId).is('rndc_notified_at', null).select('token_id'));
  return rows.length > 0;
}

export async function saveRndc(tokenId, rndc) {
  await run(supabase().from('silog_confirmaciones').update({
    radicado: rndc.radicado, rndc_migrated: rndc.migrated, rndc_fecha_hora: rndc.fechaHora, rndc_checked_at: new Date().toISOString(),
  }).eq('token_id', tokenId));
}
