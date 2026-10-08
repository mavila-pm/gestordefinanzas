import { describe, expect, it } from 'vitest';
import { ageOn, limaMonth, limaMonthRange, limaToday, normalizePhone, parseBirthDate, parseEmail, passwordProblem, safeNextPath } from '../src/web/auth-input';

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

  it('phones to E.164 (+51 for a Peruvian mobile without code; other countries need +code)', () => {
    expect(normalizePhone('987 654 321')).toBe('+51987654321');
    expect(normalizePhone('+51 987-654-321')).toBe('+51987654321');
    expect(normalizePhone('0034 612 345 678')).toBe('+34612345678');
    expect(normalizePhone('+1 (415) 555-0100')).toBe('+14155550100');
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('01 234 5678')).toBeNull(); // local landline without +code
    expect(normalizePhone('+0123456789')).toBeNull();
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
