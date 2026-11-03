import * as store from '../store/whatsapp.js';
import { getUser } from '../store/usuarios.js';
import { sendText } from './api.js';

export const realDeps = { store, getUser, send: sendText };
