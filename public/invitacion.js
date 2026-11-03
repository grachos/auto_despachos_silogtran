const token = location.pathname.split('/').filter(Boolean).pop() || '';
const f = document.getElementById('f'), go = document.getElementById('go'), msg = document.getElementById('msg');
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
      showMsg(msg, 'ok', 'Listo, tu cuenta quedó activa. Te llevamos a vincular tu teléfono…');
      setTimeout(() => { location.href = '/vincular'; }, 900);
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
