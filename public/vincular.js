const $ = (id) => document.getElementById(id);
let countdown = null, poller = null, expiresAt = 0;
const show = (id, on) => $(id).classList.toggle('hidden', !on);

function stopTimers() { clearInterval(countdown); clearInterval(poller); countdown = poller = null; }

function renderLinked(b) {
  stopTimers();
  show('start', false); show('codebox', false); hideMsg($('msg'));
  $('phone').textContent = b.telefono || '';
  $('since').textContent = b.desde ? new Date(b.desde).toLocaleString('es-CO', { dateStyle: 'long', timeStyle: 'short' }) : '';
  document.querySelectorAll('.botnum').forEach((n) => { n.textContent = b.numeroWhatsapp || 'el número del bot'; });
  $('intro').textContent = 'Tu cuenta está lista.';
  show('linked', true);
}

async function check(quiet) {
  const { status, body } = await api('/api/vinculacion/estado');
  if (status === 401) {
    stopTimers(); show('start', false); show('codebox', false);
    showMsg($('msg'), 'err', body.message || 'Tu sesión venció. Pide un link nuevo al administrador.');
    return null;
  }
  if (body.vinculado) { renderLinked(body); return true; }
  if (!quiet) show('start', true);
  return false;
}

function tick() {
  const s = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  $('left').textContent = s > 0 ? `Vence en ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.` : 'El código venció. Genera otro.';
  if (s === 0) { clearInterval(countdown); clearInterval(poller); $('sent').disabled = true; $('open').classList.add('hidden'); }
}

async function generate() {
  hideMsg($('msg'));
  $('gen').disabled = $('again').disabled = true;
  try {
    const { status, body } = await api('/api/vinculacion/codigo', { method: 'POST' });
    if (status !== 200 || !body.ok) {
      showMsg($('msg'), 'err', body.message || 'No se pudo generar el código.');
      return;
    }
    stopTimers();
    $('code').textContent = body.mensaje;
    $('tonum').textContent = body.numeroWhatsapp ? ` al ${body.numeroWhatsapp}` : '';
    const open = $('open');
    if (body.whatsappUrl) { open.href = body.whatsappUrl; open.classList.remove('hidden'); } else { open.classList.add('hidden'); }
    $('sent').disabled = false;
    expiresAt = new Date(body.expiraEn).getTime();
    show('start', false); show('codebox', true);
    tick(); countdown = setInterval(tick, 1000);
    poller = setInterval(() => check(true), 4000); // switch to "linked" by itself once the bot receives the code
  } catch {
    showMsg($('msg'), 'err', 'No hay conexión con el servidor. Intenta de nuevo.');
  } finally {
    $('gen').disabled = $('again').disabled = false;
  }
}

$('gen').addEventListener('click', generate);
$('again').addEventListener('click', generate);
$('sent').addEventListener('click', async () => {
  const linked = await check(true);
  if (linked === false) showMsg($('msg'), 'warn', 'Aún no vemos tu mensaje. Revisa que enviaste exactamente el texto del código y espera unos segundos.');
});
check(false);
