const btn = document.getElementById('copiar');
const estado = document.getElementById('estado');
btn.addEventListener('click', async () => {
  const text = document.getElementById('ejemplo').textContent;
  try {
    await navigator.clipboard.writeText(text);
    estado.textContent = ' Copiado.';
  } catch {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('ejemplo'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    estado.textContent = ' Selecciónalo y cópialo (Ctrl+C).';
  }
});
