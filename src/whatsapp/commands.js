// Command parsing for incoming text (case/accents/punctuation insensitive).
const norm = (s) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

export function parseCommand(text) {
  const t = norm(text);
  const link = /^vincular(?: despacho)? (\d{6})$/.exec(t);
  if (link) return { cmd: 'link', code: link[1] };
  if (/^vincular\b/.test(t)) return { cmd: 'link_bad' };
  if (t === 'ayuda' || t === 'ayuda despacho') return { cmd: 'help' };
  if (t === 'desvincular' || t === 'desvincular despacho') return { cmd: 'unlink' };
  return { cmd: 'text', text: String(text ?? '') };
}
