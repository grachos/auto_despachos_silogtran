// Tiny shared helpers (no frameworks). Always use textContent for server-provided text.
async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...opts });
  let body = {};
  try { body = await res.json(); } catch { /* non-JSON error page */ }
  return { status: res.status, body };
}
function showMsg(el, kind, text) {
  el.className = 'msg ' + kind;
  el.textContent = text;
}
function hideMsg(el) {
  el.className = 'msg hidden';
  el.textContent = '';
}
