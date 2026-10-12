import { describe, expect, it } from 'vitest';
import { firstGivenName, parseProfileForm, preferredName, presentName, shortFullName } from '../src/domain/profile';

const form = (o: Record<string, string>) => (k: string) => o[k];

describe('profile names (presentation only)', () => {
  it('keeps full names; greets by the first given name by default', () => {
    const r = parseProfileForm(form({ givenNames: '  Mauro   Antonio ', familyNames: 'Ávila  Pérez', displayName: '' }));
    expect(r).toEqual({ ok: true, value: { givenNames: 'Mauro Antonio', familyNames: 'Ávila Pérez', displayName: 'Mauro' } });
    expect(shortFullName(r.ok ? r.value : null)).toBe('Mauro Ávila');
  });
  it('the person can choose another name (second name, nickname) without touching full names', () => {
    const r = parseProfileForm(form({ givenNames: 'María José', familyNames: 'Ríos', displayName: 'Majo' }));
    expect(r.ok && r.value.displayName).toBe('Majo');
    expect(r.ok && r.value.givenNames).toBe('María José');
  });
  it('no name yet -> neutral greeting (null), never the email', () => {
    expect(preferredName({ givenNames: null, displayName: null })).toBeNull();
    expect(preferredName(null)).toBeNull();
    expect(firstGivenName('   ')).toBeNull();
  });
  it('existing accounts with only a display name keep it', () => {
    expect(preferredName({ displayName: 'Mauro', givenNames: null })).toBe('Mauro');
  });
  it('rejects markup/control characters and overlong values', () => {
    expect(parseProfileForm(form({ givenNames: '<script>' })).ok).toBe(false);
    expect(parseProfileForm(form({ givenNames: 'a'.repeat(81) })).ok).toBe(false);
    expect(parseProfileForm(form({ displayName: 'x'.repeat(41) })).ok).toBe(false);
  });
});

describe('names are shown well whatever case they were typed in (stored value unchanged)', () => {
  it('MAURO → Mauro; all-lowercase too; compound names; mixed case kept', () => {
    expect(preferredName({ displayName: 'MAURO', givenNames: null })).toBe('Mauro');
    expect(preferredName({ displayName: null, givenNames: 'MARÍA JOSÉ' })).toBe('María');
    expect(presentName('maría josé')).toBe('María José');
    expect(presentName("O'NEILL")).toBe("O'Neill");
    expect(presentName('JEAN-PAUL')).toBe('Jean-Paul');
    expect(presentName('McKenzie')).toBe('McKenzie');
    expect(shortFullName({ displayName: 'MAURO', familyNames: 'ÁVILA RÍOS', givenNames: null })).toBe('Mauro Ávila');
  });
});

