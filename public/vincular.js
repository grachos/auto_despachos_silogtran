const $ = (id) => document.getElementById(id);
let countdown = null, poller = null, expiresAt = 0;
let knownCount = 0;   // numbers linked as of the last status read
let baseCount = 0;    // numbers linked when the current code was generated (a bigger count = the code was used)
let waiting = false;  // a code is on screen and we are waiting for the bot to receive it

const show = (id, on) => $(id).classList.toggle('hidden', !on);

function stopTimers() { clearInterval(countdown); clearInterval(poller); countdown = poller = null; }

const fmt = (d) => (d ? new Date(d).toLocaleString('es-CO', { dateStyle: 'long', timeStyle: 'short' }) : '');
const phonesOf = (b) => (Array.isArray(b.telefonos) ? b.telefonos : (b.vinculado ? [{ telefono: b.telefono, desde: b.desde }] : []));

function renderLinked(b) {
  stopTimers(); waiting = false;
  show('start', false); show('codebox', false); hideMsg($('msg'));
  const list = phonesOf(b), max = b.maxTelefonos || 2;
  $('title').textContent = list.length > 1 ? 'Tus WhatsApp están vinculados' : 'Tu WhatsApp está vinculado';
  const ul = $('phones');
  ul.replaceChildren();
  list.forEach((p) => {
    const li = document.createElement('li');
    const strong = document.createElement('strong');
    strong.textContent = p.telefono || '';
    li.append(strong, document.createTextNode(p.desde ? ` · desde ${fmt(p.desde)}` : ''));
    ul.append(li);
  });
  document.querySelectorAll('.botnum').forEach((n) => { n.textContent = b.numeroWhatsapp || 'el número del bot'; });
  show('addphone', list.length < max); show('addinfo', list.length < max);
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
  knownCount = phonesOf(body).length;
  if (waiting) {
    // Adding a number: "linked" only once the count grows (the account may already have one number).
    if (knownCount > baseCount) { renderLinked(body); return true; }
    return false;
  }
  if (knownCount > 0) { renderLinked(body); return true; }
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
  $('addphone').disabled = true;
  $('gen').disabled = $('again').disabled = true;
  try {
    const { status, body } = await api('/api/vinculacion/codigo', { method: 'POST' });
    if (status !== 200 || !body.ok) {
      showMsg($('msg'), 'err', body.message || 'No se pudo generar el código.');
      return;
    }
    stopTimers(); waiting = true; baseCount = knownCount;
    $('code').textContent = body.mensaje;
    $('tonum').textContent = body.numeroWhatsapp ? ` al ${body.numeroWhatsapp}` : '';
    const open = $('open');
    if (body.whatsappUrl) { open.href = body.whatsappUrl; open.classList.remove('hidden'); } else { open.classList.add('hidden'); }
    $('sent').disabled = false;
    expiresAt = new Date(body.expiraEn).getTime();
    show('start', false); show('linked', false); show('codebox', true);
    tick(); countdown = setInterval(tick, 1000);
    poller = setInterval(() => check(true), 4000); // switch to "linked" by itself once the bot receives the code
  } catch {
    showMsg($('msg'), 'err', 'No hay conexión con el servidor. Intenta de nuevo.');
  } finally {
    $('gen').disabled = $('again').disabled = $('addphone').disabled = false;
  }
}

$('gen').addEventListener('click', generate);
$('again').addEventListener('click', generate);
$('addphone').addEventListener('click', generate);
$('sent').addEventListener('click', async () => {
  const linked = await check(true);
  if (linked === false) showMsg($('msg'), 'warn', 'Aún no vemos tu mensaje. Revisa que enviaste exactamente el texto del código y espera unos segundos.');
});
check(false);
