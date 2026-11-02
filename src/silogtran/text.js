// Small text helpers shared by the page parsers.
export const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

export const cell = (s) => String(s ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
export const int = (s) => Number.parseInt(String(s).replace(/[^\d-]/g, ''), 10) || 0;
