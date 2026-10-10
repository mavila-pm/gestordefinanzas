/**
 * Own categories are labels only: they group spending ("Mascotas", "Gimnasio"). The financial meaning of a movement
 * (expense, income, own transfer, card payment, withdrawal, refund) is its type, never its category.
 */
export const CATEGORY_MAX = 40;
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es');

export function parseCategoryName(v: unknown, existing: readonly string[]): { ok: true; name: string } | { ok: false; error: string } {
  const name = typeof v === 'string' ? v.normalize('NFC').trim().replace(/\s+/g, ' ') : '';
  if (!name) return { ok: false, error: 'Escribe un nombre.' };
  if (name.length > CATEGORY_MAX || /[\u0000-\u001f\u007f<>]/.test(name)) return { ok: false, error: `Usa hasta ${CATEGORY_MAX} caracteres, sin símbolos especiales.` };
  if (existing.some((e) => fold(e) === fold(name))) return { ok: false, error: 'Ya tienes una categoría con ese nombre.' };
  return { ok: true, name: name[0]!.toLocaleUpperCase('es') + name.slice(1) };
}
