import * as store from '../store/whatsapp.js';
import { getUser } from '../store/usuarios.js';
import { sendText, sendTyping } from './api.js';
import { waitUntil } from '@vercel/functions';
import { realFlow } from '../ai/deps.js';

// Long work (AI + Silogtran) continues after Meta got its 200; on failure the flow apologizes to the person.
const defer = (p) => {
  p.catch(() => {});
  try { waitUntil(p); } catch { /* not running on Vercel (local/tests): the promise just runs */ }
};

export const realDeps = { store, getUser, send: sendText, typing: sendTyping, flow: realFlow, defer };
