// Audit of activation attempts. Best effort: a failure here must never break (or hide) the activation result.
import { supabase } from './supabase.js';

export async function logActivation(row) {
  try {
    const { error } = await supabase().from('silog_activaciones').insert({
      tipo: row.tipo, referencia: String(row.referencia).slice(0, 40), actor: row.actor ?? 'default', resultado: row.resultado,
      error_code: row.error_code ?? null, detalle: row.detalle ? String(row.detalle).slice(0, 400) : null, ms: row.ms ?? null,
    });
    if (error) console.error('[mcp] audit failed:', error.code || 'error');
  } catch (e) {
    console.error('[mcp] audit failed:', e?.code || e?.name || 'error');
  }
}
