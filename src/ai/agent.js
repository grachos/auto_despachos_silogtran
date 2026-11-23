// One assistant turn: the model may call consultar_solicitud / preparar_despacho (nothing else exists).
// A successful preparar ends the turn: the SERVER then shows the summary + buttons.
import { systemPrompt } from './prompt.js';
import { TOOLS, toolError } from './tools.js';
import { timed } from '../perf.js';

const MAX_STEPS = 4;

// deps: { chat, executors, history[], now }
export async function runAgentTurn({ nombre, text, history = [], now = new Date() }, deps) {
  const messages = [{ role: 'system', content: systemPrompt(nombre, now) }, ...history, { role: 'user', content: String(text).slice(0, 3000) }];
  let consulted = false;
  // A message that carries a request number (always 0101xxxxxx, 10 digits) needs consultar_solicitud first anyway: run that read-only lookup
  // here, in code, and show the result to the model as if it had called the tool. That saves one model round trip (~2-3 s) per turn.
  // Any problem (not found, busy session, not a request number) is ignored and the normal model-driven flow continues unchanged.
  const numbers = [...new Set(String(text).match(/\b01\d{8}\b/g) ?? [])];
  const requestNumber = numbers.length === 1 ? numbers[0] : undefined; // several numbers = a batch table: no single lookup
  if (requestNumber && Object.hasOwn(deps.executors, 'consultar_solicitud')) {
    try {
      const out = await deps.executors.consultar_solicitud({ numero: requestNumber });
      if (out?.result) {
        messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'pre_consult', type: 'function', function: { name: 'consultar_solicitud', arguments: JSON.stringify({ numero: requestNumber }) } }] });
        messages.push({ role: 'tool', tool_call_id: 'pre_consult', content: JSON.stringify(out.result).slice(0, 4000) });
        consulted = true;
      }
    } catch { /* the model decides what to do */ }
  }
  for (let step = 0; step < MAX_STEPS; step++) {
    let msg = await timed('llm', () => deps.chat({ messages, tools: TOOLS }));
    let calls = msg.tool_calls ?? [];
    // Facts about a request (does it exist, can it be dispatched, is a plate available) only come from Silogtran. If the
    // person named a request number and the model answered without any tool, it improvised: force a (read-only) lookup.
    if (!calls.length && step === 0 && !consulted && /\d{6,}/.test(String(text)) && numbers.length <= 1) {
      msg = await timed('llm', () => deps.chat({ messages, tools: TOOLS, toolChoice: { type: 'function', function: { name: 'consultar_solicitud' } } }));
      calls = msg.tool_calls ?? [];
    }
    if (calls.some((c) => c.function?.name === 'consultar_solicitud')) consulted = true;
    if (!calls.length) {
      const out = String(msg.content ?? '').trim();
      return { kind: 'text', text: (out || 'No te entendí bien. ¿Me cuentas qué solicitud quieres despachar?').slice(0, 3500) };
    }
    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
    for (const [i, call] of calls.entries()) {
      let result;
      const name = call.function?.name;
      const exec = Object.hasOwn(deps.executors, name) ? deps.executors[name] : null;
      if (i > 0) result = { ok: false, code: 'ONE_AT_A_TIME', message: 'Usa una herramienta a la vez.' };
      else if (!exec) result = { ok: false, code: 'UNKNOWN_TOOL', message: 'Herramienta no disponible.' }; // e.g. a made-up "confirmar_despacho"
      else {
        let args;
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = null; }
        if (!args || typeof args !== 'object') result = { ok: false, code: 'INVALID_ARGUMENTS', message: 'Argumentos inválidos.' };
        else {
          try {
            const out = await exec(args);
            if (out.pending) return { kind: 'pending', ...out.pending };
            if (out.reply) return { kind: 'text', text: out.reply, ...(out.buttons?.length ? { buttons: out.buttons } : {}) };
            result = out.result;
          } catch (e) {
            const te = toolError(e);
            if (te.fixed) return { kind: 'text', text: te.fixed };
            result = te.result;
          }
        }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 4000) });
    }
  }
  return { kind: 'text', text: 'No pude completar eso. ¿Puedes darme de nuevo los datos del despacho (solicitud, placa y citas de cargue y descargue)?' };
}
