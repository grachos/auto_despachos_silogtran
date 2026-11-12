// «Enviar Ministerio» (resend a manifest to the Ministry/RNDC): the same plain form submit as the browser capture of the manifest page
// (empty PRADO_POSTBACK_TARGET/PARAMETER, button name=value, every IDLockHidden_* = true, all the other fields untouched).
// It never presses the button when the manifest already has a filing number (radicado): there is nothing to resend.
import { ApiError } from '../http/errors.js';
import { parseRndc } from './grabar.js';
import { pressPrintButton } from './imprimir.js';

export const SEND_LABEL = 'Enviar Ministerio';
const manifestPage = (manifiesto) => `index.php?page=Despacho.Manifiesto_003.Home_111&manifiesto_codigo=${encodeURIComponent(manifiesto)}`;

// Returns { skipped: 'ALREADY_MIGRATED', rndc } without pressing, or { skipped: null, res, btn } with the raw answer of the press.
export async function sendToMinistry(client, manifiesto, { timeoutSec = 25 } = {}) {
  const before = parseRndc((await client.request(manifestPage(manifiesto), { timeoutSec })).text);
  if (before?.migrated) return { skipped: 'ALREADY_MIGRATED', rndc: before };
  try {
    const { res, btn } = await pressPrintButton(client, manifiesto, SEND_LABEL, { timeoutSec });
    return { skipped: null, res, btn, before };
  } catch (e) {
    if (e?.code === 'PRINT_BUTTON_NOT_FOUND') throw new ApiError('MINISTRY_BUTTON_NOT_FOUND', 'No encontré el botón «Enviar Ministerio» en ese manifiesto (puede que no aplique a este viaje).', { status: 404 });
    throw e;
  }
}
