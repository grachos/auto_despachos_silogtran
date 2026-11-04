// One assistant turn: the model may call consultar_solicitud / preparar_despacho (nothing else exists).
// A successful preparar ends the turn: the SERVER then shows the summary + buttons.
import { systemPrompt } from './prompt.js';
import { TOOLS, toolError } from './tools.js';

const MAX_STEPS = 4;

// deps: { chat, executors, history[], now }
export async function runAgentTurn({ nombre, text, history = [], now = new Date() }, deps) {
  const messages = [{ role: 'system', content: systemPrompt(nombre, now) }, ...history, { role: 'user', content: String(text).slice(0, 1000) }];
  for (let step = 0; step < MAX_STEPS; step++) {
    const msg = await deps.chat({ messages, tools: TOOLS });
    const calls = msg.tool_calls ?? [];
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
