// Real dependencies of the assistant flow.
import * as ia from '../store/ia.js';
import { withLock } from '../store/locks.js';
import { chatComplete, transcribe, aiAvailable } from './openai.js';
import { downloadMedia } from '../whatsapp/media.js';
import { sendText, sendButtons, sendLinkButton } from '../whatsapp/api.js';
import { confirmDispatch } from '../confirmar.js';
import { prepareDispatch } from '../dispatch/service.js';
import { startMinistryWatch } from '../ministerio/watch.js';
import { resendToMinistry } from '../ministerio/resend.js';
import { startLote, cancelLote } from '../store/lotes.js';
import { kickLoteStep } from '../lote/worker.js';
import { createFlow } from './flow.js';

export const realFlow = createFlow({
  ia: { ...ia },
  pendingProblem: ia.pendingProblem,
  chat: chatComplete,
  transcribe,
  downloadMedia: (id) => downloadMedia(id),
  confirmDispatch: (numero, o) => confirmDispatch(numero, { ...o, origen: 'whatsapp' }),
  watchMinistry: startMinistryWatch,
  resend: resendToMinistry,
  prepareDispatch,
  lote: { start: startLote, cancel: cancelLote, kick: kickLoteStep },
  withLock: (key, fn) => withLock(key, fn),
  send: sendText,
  sendButtons,
  sendLinkButton,
  aiAvailable,
  now: () => new Date(),
});
