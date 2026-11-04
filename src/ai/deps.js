// Real dependencies of the assistant flow.
import * as ia from '../store/ia.js';
import { withLock } from '../store/locks.js';
import { chatComplete, transcribe, aiAvailable } from './openai.js';
import { downloadMedia } from '../whatsapp/media.js';
import { sendText, sendButtons } from '../whatsapp/api.js';
import { confirmDispatch } from '../confirmar.js';
import { createFlow } from './flow.js';

export const realFlow = createFlow({
  ia: { ...ia },
  pendingProblem: ia.pendingProblem,
  chat: chatComplete,
  transcribe,
  downloadMedia: (id) => downloadMedia(id),
  confirmDispatch,
  withLock: (key, fn) => withLock(key, fn),
  send: sendText,
  sendButtons,
  aiAvailable,
  now: () => new Date(),
});
