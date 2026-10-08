import { describe, expect, it } from 'vitest';
import { ageOn, birthProblem, limaMonth, limaMonthRange, limaToday, normalizePhone, parseBirthDate, parseEmail, passwordProblem, safeNextPath } from '../src/web/auth-input';

describe('auth input validation', () => {
  it('emails', () => {
    expect(parseEmail('  Mauro@Example.PE ')).toBe('mauro@example.pe');
    expect(parseEmail('no-at-sign')).toBeNull();
    expect(parseEmail({})).toBeNull();
  });

  it('passwords', () => {
    expect(passwordProblem('abc12345678')).toMatch(/al menos 12/); // 11
    expect(passwordProblem('abcdefghijkl')).toMatch(/letras y números/); // only letters
    expect(passwordProblem('123456789012')).toMatch(/letras y números/); // only numbers
    expect(passwordProblem('abcdefghijk1')).toBeNull(); // 12, letter + number
    expect(passwordProblem('contraseña segura 2026')).toBeNull(); // spaces and ñ allowed, no symbols required
    expect(passwordProblem('ñ1' + 'ñ'.repeat(40))).toMatch(/demasiado larga/); // > 72 bytes: refused, never truncated
    expect(passwordProblem(undefined)).not.toBeNull();
    expect(passwordProblem('')).not.toBeNull();
  });

  it('phones: Peruvian mobile only, 9 digits starting with 9, stored as +519XXXXXXXX', () => {
    expect(normalizePhone('987654321')).toBe('+51987654321');
    expect(normalizePhone('987 654 321')).toBe('+51987654321');
    expect(normalizePhone('98765432')).toBeNull(); // 8 digits
    expect(normalizePhone('9876543210')).toBeNull(); // 10 digits
    expect(normalizePhone('887654321')).toBeNull(); // not a mobile
    expect(normalizePhone('+51987654321')).toBeNull(); // the +51 is fixed in the form, never typed
    expect(normalizePhone('+34612345678')).toBeNull(); // another country
    expect(normalizePhone('98765432a')).toBeNull();
    expect(normalizePhone('987-654-321')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });

  it('birth date for the profile step: 18 on the exact Lima day, future/invalid refused, a fix clears the error', () => {
    expect(birthProblem('2008-10-08', '2026-10-08')).toBeNull(); // turns 18 today
    expect(birthProblem('2008-10-09', '2026-10-08')).toBe('Velsuno es para personas mayores de 18 años.');
    expect(birthProblem('2030-01-01', '2026-10-08')).toBe('Revisa tu fecha de nacimiento.');
    expect(birthProblem('2008-02-30', '2026-10-08')).toBe('Revisa tu fecha de nacimiento.');
    expect(birthProblem('1990-05-01', '2026-10-08')).toBeNull();
  });

  it('birth dates and age (18+ by calendar, birthday counts)', () => {
    expect(parseBirthDate('2008-02-30')).toBeNull();
    expect(parseBirthDate('1899-12-31')).toBeNull();
    expect(parseBirthDate('2000-01-15')).toBe('2000-01-15');
    expect(ageOn('2008-10-08', '2026-10-08')).toBe(18);
    expect(ageOn('2008-10-09', '2026-10-08')).toBe(17);
    expect(ageOn('2008-02-29', '2026-02-28')).toBe(17);
    expect(limaToday(new Date('2026-10-09T04:59:00Z'))).toBe('2026-10-08');
  });

  it.each([
    ['/app', '/app'], ['/app/transactions?x=1', '/app/transactions?x=1'],
    ['//evil.com', '/app'], ['https://evil.com', '/app'], ['/\\evil.com', '/app'], ['', '/app'], [undefined, '/app'], ['/app\r\nSet-Cookie: x', '/app'],
  ])('safeNextPath(%s) -> %s', (input, out) => expect(safeNextPath(input)).toBe(out));

  it('Lima month boundaries', () => {
    expect(limaMonth(new Date('2026-10-01T04:59:00Z'))).toBe('2026-09');
    expect(limaMonth(new Date('2026-10-01T05:00:00Z'))).toBe('2026-10');
    expect(limaMonthRange('2026-12')).toEqual({ from: '2026-12-01T05:00:00.000Z', to: '2027-01-01T05:00:00.000Z' });
    expect(limaMonthRange('2026-13')).toBeNull();
    expect(limaMonthRange("2026-09' or 1=1")).toBeNull();
  });
});
