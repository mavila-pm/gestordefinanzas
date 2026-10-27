import { describe, expect, it } from 'vitest';
import { parseCategoryName } from '../src/web/category-input';

describe('own categories: labels only, validated', () => {
  it('trims, capitalizes, refuses empty, long, symbols and duplicates (accents and case ignored)', () => {
    expect(parseCategoryName('  mascotas ', ['Alimentación'])).toEqual({ ok: true, name: 'Mascotas' });
    expect(parseCategoryName('', []).ok).toBe(false);
    expect(parseCategoryName('x'.repeat(41), []).ok).toBe(false);
    expect(parseCategoryName('<b>', []).ok).toBe(false);
    expect(parseCategoryName('alimentacion', ['Alimentación'])).toEqual({ ok: false, error: 'Ya tienes una categoría con ese nombre.' });
    expect(parseCategoryName(42, []).ok).toBe(false);
  });
});
