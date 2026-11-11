const $ = (id) => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle('hidden', !on);
let countdown = null, expiresAt = 0;
const when = (iso) => (iso ? new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : 'sin usar');

function el(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }

function renderConnections(list) {
  const t = $('connTable');
  t.replaceChildren();
  const head = t.createTHead().insertRow();
  for (const h of ['Cliente', 'Alcance', 'Creada', 'Último uso', '']) head.appendChild(el('th', h));
  const body = t.createTBody();
  if (!list.length) { const td = body.insertRow().insertCell(); td.colSpan = 5; td.className = 'empty'; td.textContent = 'Aún no tienes conexiones.'; return; }
  for (const c of list) {
    const tr = body.insertRow();
    tr.insertCell().textContent = c.etiqueta || 'Cliente MCP';
    tr.insertCell().textContent = c.alcance;
    tr.insertCell().textContent = when(c.creada);
    tr.insertCell().textContent = when(c.ultimoUso);
    const b = el('button', 'Revocar', 'btn small');
    b.type = 'button';
    b.addEventListener('click', async () => {
      if (!confirm('¿Revocar esta conexión? Dejará de funcionar de inmediato.')) return;
      b.disabled = true;
      await api('/api/vinculacion/mcp-revocar', { method: 'POST', body: JSON.stringify({ id: c.id }) });
      load();
    });
    tr.insertCell().appendChild(b);
  }
}

async function load() {
  const { status, body } = await api('/api/vinculacion/mcp-conexiones');
  if (status === 401) { showMsg($('msg'), 'err', body.message || 'Tu sesión venció. Entra de nuevo con tu link de invitación.'); show('start', false); show('conns', false); return; }
  hideMsg($('msg'));
  const enabled = (body.alcances || []).includes('activar');
  show('off', !enabled); show('start', enabled && $('ticketbox').classList.contains('hidden'));
  $('url').value = body.conectorUrl || '';
  show('conns', true);
  renderConnections(body.conexiones || []);
}

function tick() {
  const s = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  $('left').textContent = s > 0 ? `Vence en ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.` : 'El ticket venció. Genera otro.';
  if (s === 0) clearInterval(countdown);
}

async function generate() {
  hideMsg($('msg'));
  $('gen').disabled = $('again').disabled = true;
  try {
    const { status, body } = await api('/api/vinculacion/mcp-ticket', { method: 'POST', body: JSON.stringify({ scope: 'activar' }) });
    if (status !== 200 || !body.ok) { showMsg($('msg'), 'err', body.message || 'No se pudo generar el ticket.'); return; }
    $('ticket').textContent = body.ticket;
    $('url').value = body.conectorUrl;
    expiresAt = new Date(body.expiraEn).getTime();
    show('start', false); show('ticketbox', true);
    clearInterval(countdown); tick(); countdown = setInterval(tick, 1000);
  } catch { showMsg($('msg'), 'err', 'No hay conexión con el servidor. Intenta de nuevo.'); }
  finally { $('gen').disabled = $('again').disabled = false; }
}

$('gen').addEventListener('click', generate);
$('again').addEventListener('click', generate);
$('copyurl').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('url').value); showMsg($('msg'), 'ok', 'Dirección copiada.'); } catch { $('url').select(); } });
load();
setInterval(() => { if (!document.hidden) load(); }, 30000); // a new connection appears here once the client authorizes
