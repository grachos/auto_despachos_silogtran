const $ = (id) => document.getElementById(id);
$('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideMsg($('msg')); $('result').classList.add('hidden');
  const payload = $('i').value.trim() ? { userId: $('i').value.trim() } : { nombre: $('n').value.trim() };
  $('go').disabled = true;
  try {
    const res = await fetch('/api/admin/invitaciones', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': $('k').value },
      body: JSON.stringify(payload),
    });
    const b = await res.json().catch(() => ({}));
    if (!res.ok || !b.ok) { showMsg($('msg'), 'err', (b.message || 'No se pudo generar el link.') + (b.code ? ` (${b.code})` : '')); return; }
    $('who').textContent = `Usuario: ${b.usuario.nombre} (ID ${b.usuario.id})`;
    $('link').value = b.invitacion.link;
    $('exp').textContent = `Vence: ${new Date(b.invitacion.expiraEn).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' })}`;
    $('result').classList.remove('hidden');
  } catch {
    showMsg($('msg'), 'err', 'No hay conexión con el servidor.');
  } finally {
    $('go').disabled = false;
  }
});
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('link').value); showMsg($('msg'), 'ok', 'Link copiado.'); }
  catch { $('link').select(); showMsg($('msg'), 'warn', 'Selecciona y copia el link manualmente.'); }
});
