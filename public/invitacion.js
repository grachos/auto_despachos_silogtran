// Token from ?t=<token> (preferred link format) or from the last path segment (/invitacion/<token>).
const qs = new URLSearchParams(location.search).get('t');
const last = location.pathname.split('/').filter(Boolean).pop() || '';
const token = qs || (last === 'invitacion' || last === 'invitacion.html' ? '' : last);
const f = document.getElementById('f'), go = document.getElementById('go'), msg = document.getElementById('msg');
const PURPOSE = {
  whatsapp: ['Vincular WhatsApp', 'Este link es para vincular tu WhatsApp y despachar desde el chat.', 'Listo, tu cuenta quedó activa. Te llevamos a vincular tu teléfono…'],
  activar: ['Activar vehículos y proveedores', 'Este link es solo para conectar tu IA (Claude o ChatGPT) y activar vehículos y proveedores en Silogtran.', 'Listo, tu acceso quedó habilitado. Te llevamos a generar tu ticket…'],
};
let purpose = PURPOSE.whatsapp;
// What is this link for? (read-only; spends no attempt)
if (token) {
  api(`/api/invitaciones/${encodeURIComponent(token)}/login`).then(({ status, body }) => {
    if (status === 200 && body.ok && PURPOSE[body.scope]) {
      purpose = PURPOSE[body.scope];
      document.getElementById('title').textContent = purpose[0];
      document.getElementById('purpose').textContent = purpose[1];
    }
  }).catch(() => {});
}
const FINAL = ['INVITATION_NOT_FOUND', 'INVITATION_USED', 'INVITATION_EXPIRED', 'INVITATION_LOCKED'];

f.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideMsg(msg);
  go.disabled = true;
  go.textContent = 'Verificando en Silogtran…';
  const usuario = document.getElementById('u').value.trim();
  const clave = document.getElementById('p').value;
  try {
    const { status, body } = await api(`/api/invitaciones/${encodeURIComponent(token)}/login`, {
      method: 'POST',
      body: JSON.stringify({ usuario, clave }),
    });
    document.getElementById('p').value = '';
    if (status === 200 && body.ok) {
      showMsg(msg, 'ok', purpose[2]);
      setTimeout(() => { location.href = body.siguiente || '/vincular'; }, 900);
      return;
    }
    let text = body.message || 'No se pudo completar el ingreso. Intenta de nuevo.';
    if (typeof body.intentosRestantes === 'number') text += ` Intentos restantes: ${body.intentosRestantes}.`;
    if (body.motivoSilogtran) text += ` (Silogtran dice: ${body.motivoSilogtran})`;
    showMsg(msg, 'err', text);
    if (FINAL.includes(body.code) || body.intentosRestantes === 0) {
      f.querySelectorAll('input,button').forEach((x) => { x.disabled = true; });
      go.textContent = 'Ingresar';
      return;
    }
  } catch {
    showMsg(msg, 'err', 'No hay conexión con el servidor. Intenta de nuevo.');
  }
  go.disabled = false;
  go.textContent = 'Ingresar';
});
