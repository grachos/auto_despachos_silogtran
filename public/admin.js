const $ = (id) => document.getElementById(id);
const TZ = 'America/Bogota';
let users = [];

const secs = (ms) => (ms === null || ms === undefined ? '—' : `${(ms / 1000).toFixed(1)} s`);
const when = (iso) => (iso ? new Date(iso).toLocaleString('es-CO', { timeZone: TZ, dateStyle: 'short', timeStyle: 'medium' }) : '—');
const ymd = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toLocaleDateString('en-CA', { timeZone: TZ });
const dash = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined && text !== null) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
const badge = (text, kind) => el('span', text, `badge ${kind}`);

// Builds a table with textContent only (server data is never interpreted as HTML).
function renderTable(table, columns, rows, emptyText) {
  table.replaceChildren();
  const head = table.createTHead().insertRow();
  for (const c of columns) head.appendChild(el('th', c.h));
  const body = table.createTBody();
  if (!rows.length) {
    const td = body.insertRow().insertCell();
    td.colSpan = columns.length;
    td.className = 'empty';
    td.textContent = emptyText;
    return;
  }
  for (const r of rows) {
    const tr = body.insertRow();
    for (const c of columns) {
      const td = tr.insertCell();
      const v = c.v(r);
      if (v instanceof Node) td.appendChild(v); else td.textContent = v;
    }
  }
}

function kpi(container, items) {
  container.replaceChildren();
  for (const [v, l] of items) { const d = el('div', null, 'kpi'); d.append(el('div', v, 'v'), el('div', l, 'l')); container.appendChild(d); }
}

const estadoBadge = (e) => badge({ DONE: 'Exitoso', FAILED: 'Fallido', UNKNOWN: 'Incierto' }[e] || e, { DONE: 'ok', FAILED: 'err', UNKNOWN: 'warn' }[e] || 'mute');

// ---- session ----
function showLogin() { $('appView').classList.add('hidden'); $('loginView').classList.remove('hidden'); }
function showApp() { $('loginView').classList.add('hidden'); $('appView').classList.remove('hidden'); }

async function guard(res) {
  if (res.status === 401 && res.body.code === 'ADMIN_REQUIRED') { showLogin(); return false; }
  return true;
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); hideMsg($('loginMsg')); $('loginGo').disabled = true;
  try {
    const { status, body } = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ key: $('k').value }) });
    $('k').value = '';
    if (status === 200 && body.ok) { await start(); return; }
    showMsg($('loginMsg'), 'err', body.message || 'No se pudo iniciar sesión.');
  } catch { showMsg($('loginMsg'), 'err', 'No hay conexión con el servidor.'); }
  finally { $('loginGo').disabled = false; }
});
$('logout').addEventListener('click', async () => { await api('/api/admin/logout', { method: 'POST' }); showLogin(); });

// ---- tabs ----
function openTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  ['resumen', 'usuarios', 'despachos', 'invitaciones'].forEach((n) => $('tab-' + n).classList.toggle('hidden', n !== name));
  if (name === 'resumen') loadResumen(); else if (name === 'usuarios') loadUsers(); else if (name === 'despachos') loadDispatches();
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => openTab(t.dataset.tab)));

// ---- usuarios ----
async function fetchUsers() {
  const res = await api('/api/admin/usuarios');
  if (!(await guard(res))) return null;
  if (!res.body.ok) { showMsg($('dispMsg'), 'err', res.body.message || 'No se pudieron cargar los usuarios.'); return null; }
  users = res.body.usuarios;
  const sel = $('du'), keep = sel.value;
  sel.replaceChildren(new Option('Todos', ''), new Option('API (usuario cero)', 'cero'), ...users.map((u) => new Option(u.nombre, u.id)));
  sel.value = keep;
  return res.body;
}

async function loadUsers() {
  const b = await fetchUsers();
  if (!b) return;
  kpi($('usersKpis'), [[b.resumen.total, 'Usuarios'], [b.resumen.activos, 'Activos'], [b.resumen.vinculados, 'Con WhatsApp vinculado'], [b.resumen.requierenLink ?? 0, 'Requieren link nuevo']]);
  renderTable($('usersTable'), [
    { h: 'Nombre', v: (u) => u.nombre },
    { h: 'Usuario Silogtran', v: (u) => dash(u.silogUser) },
    { h: 'Estado', v: (u) => badge({ ACTIVE: 'Activo', PENDING: 'Pendiente', NEEDS_RELINK: 'Requiere link nuevo', DISABLED: 'Deshabilitado' }[u.estado] || u.estado, { ACTIVE: 'ok', NEEDS_RELINK: 'err' }[u.estado] || 'warn') },
    { h: 'WhatsApp', v: (u) => badge(u.whatsapp === 'VINCULADO' ? 'Vinculado' : 'Desvinculado', u.whatsapp === 'VINCULADO' ? 'ok' : 'mute') },
    { h: 'Teléfono', v: (u) => dash(u.telefono) },
    { h: 'Vinculado desde', v: (u) => when(u.vinculadoDesde) },
    { h: 'Despachos', v: (u) => u.despachos },
    { h: 'Último despacho', v: (u) => when(u.ultimoDespacho) },
    { h: 'Creado', v: (u) => when(u.creadoEn) },
    { h: 'ID', v: (u) => u.id },
  ], users, 'Aún no hay usuarios.');
}

// ---- resumen ----
async function loadResumen() {
  const days = Number($('period').value);
  const [rep, usr] = await Promise.all([api(`/api/admin/reporte?desde=${ymd(days)}`), fetchUsers()]);
  if (!(await guard(rep)) || !rep.body.ok) return;
  const k = rep.body.kpis;
  kpi($('kpis'), [
    [k.exitosos, `Despachos exitosos (de ${k.intentos} intentos)`],
    [k.exitoPct === null ? '—' : `${k.exitoPct}%`, 'Tasa de éxito'],
    [secs(k.totalMs.promedio), 'Tiempo total promedio'],
    [secs(k.totalMs.p50), 'Mediana (p50)'],
    [secs(k.totalMs.p90), 'p90 (el 10% más lento)'],
    [secs(k.prepararMsPromedio), 'Preparar el formulario (prom.)'],
    [secs(k.grabarMsPromedio), 'Grabar en Silogtran (prom.)'],
    [`${k.migrados} / ${k.migrados + k.sinMigrar}`, 'Migrados al Ministerio'],
    [k.fallidos + k.inciertos, 'Fallidos o inciertos'],
    ...(usr ? [[`${usr.resumen.vinculados} / ${usr.resumen.total}`, 'Usuarios con WhatsApp vinculado']] : []),
  ]);
}
$('period').addEventListener('change', loadResumen);

// ---- despachos ----
function dispQuery(extra = '') {
  const p = new URLSearchParams();
  if ($('d1').value) p.set('desde', $('d1').value);
  if ($('d2').value) p.set('hasta', $('d2').value);
  if ($('du').value) p.set('usuario', $('du').value);
  if ($('de').value) p.set('estado', $('de').value);
  return p.toString() + extra;
}

async function loadDispatches() {
  if (!$('d1').value) $('d1').value = ymd(30);
  if (!users.length) await fetchUsers();
  hideMsg($('dispMsg'));
  $('csv').href = '/api/admin/reporte?' + dispQuery('&format=csv');
  const res = await api('/api/admin/reporte?' + dispQuery());
  if (!(await guard(res))) return;
  if (!res.body.ok) { showMsg($('dispMsg'), 'err', res.body.message || 'No se pudo cargar el reporte.'); return; }
  renderTable($('dispTable'), [
    { h: 'Fecha', v: (r) => when(r.fecha) },
    { h: 'Usuario', v: (r) => r.usuario || 'API (usuario cero)' },
    { h: 'Solicitud', v: (r) => dash(r.solicitud) },
    { h: 'Placa', v: (r) => dash(r.placa) },
    { h: 'Estado', v: (r) => estadoBadge(r.estado) },
    { h: 'Orden de cargue', v: (r) => dash(r.ordenCargue) },
    { h: 'Remesa', v: (r) => dash(r.remesa) },
    { h: 'Manifiesto', v: (r) => dash(r.manifiesto) },
    { h: 'Transferencia', v: (r) => dash(r.transferencia) },
    { h: 'Radicado', v: (r) => (r.radicado ? r.radicado : r.manifiesto ? badge('Sin migrar', 'warn') : '—') },
    { h: 'Fecha/hora Ministerio', v: (r) => dash(r.rndcFechaHora) },
    { h: 'Preparar', v: (r) => secs(r.prepareMs) },
    { h: 'Grabar', v: (r) => secs(r.saveMs) },
    { h: 'Total', v: (r) => secs(r.totalMs) },
    { h: 'Error', v: (r) => dash(r.errorCode) },
  ], res.body.filas, 'No hay despachos en este periodo.');
  if (res.body.truncado) showMsg($('dispMsg'), 'warn', 'Se muestran los 1000 más recientes; acota las fechas para ver el resto.');
}
$('dispForm').addEventListener('submit', (e) => { e.preventDefault(); loadDispatches(); });

$('rndc').addEventListener('click', async () => {
  $('rndc').disabled = true; showMsg($('dispMsg'), 'warn', 'Consultando el Ministerio en Silogtran… puede tardar unos segundos.');
  try {
    const { status, body } = await api('/api/admin/rndc-actualizar', { method: 'POST' });
    if (status === 200 && body.ok) {
      showMsg($('dispMsg'), 'ok', body.mensaje || `Revisados ${body.revisados} manifiestos; nuevos radicados: ${body.nuevosRadicados}${body.errores ? `; con error: ${body.errores}` : ''}.`);
      await loadDispatches();
      showMsg($('dispMsg'), 'ok', body.mensaje || `Revisados ${body.revisados} manifiestos; nuevos radicados: ${body.nuevosRadicados}${body.errores ? `; con error: ${body.errores}` : ''}.`);
    } else if (await guard({ status, body })) showMsg($('dispMsg'), 'err', body.message || 'No se pudo actualizar.');
  } catch { showMsg($('dispMsg'), 'err', 'No hay conexión con el servidor.'); }
  finally { $('rndc').disabled = false; }
});

// ---- invitaciones ----
$('invForm').addEventListener('submit', async (e) => {
  e.preventDefault(); hideMsg($('invMsg')); $('invResult').classList.add('hidden'); $('invGo').disabled = true;
  const payload = $('i').value.trim() ? { userId: $('i').value.trim() } : { nombre: $('n').value.trim() };
  try {
    const { status, body } = await api('/api/admin/invitaciones', { method: 'POST', body: JSON.stringify(payload) });
    if (!(await guard({ status, body }))) return;
    if (status !== 200 || !body.ok) { showMsg($('invMsg'), 'err', (body.message || 'No se pudo generar el link.') + (body.code ? ` (${body.code})` : '')); return; }
    $('who').textContent = `Usuario: ${body.usuario.nombre} (ID ${body.usuario.id})`;
    $('link').value = body.invitacion.link;
    $('exp').textContent = `Vence: ${when(body.invitacion.expiraEn)}`;
    $('invResult').classList.remove('hidden');
  } catch { showMsg($('invMsg'), 'err', 'No hay conexión con el servidor.'); }
  finally { $('invGo').disabled = false; }
});
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('link').value); showMsg($('invMsg'), 'ok', 'Link copiado.'); }
  catch { $('link').select(); showMsg($('invMsg'), 'warn', 'Selecciona y copia el link manualmente.'); }
});

// ---- start ----
async function start() {
  const res = await api('/api/admin/usuarios');
  if (res.status === 401) { showLogin(); return; }
  showApp();
  openTab('resumen');
}
start();
