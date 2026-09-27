import { describe, expect, it } from 'vitest';
import { limaMonth, limaMonthRange, parseEmail, passwordProblem, safeNextPath } from '../src/web/auth-input';

describe('auth input validation', () => {
  it('emails', () => {
    expect(parseEmail('  Mauro@Example.PE ')).toBe('mauro@example.pe');
    expect(parseEmail('no-at-sign')).toBeNull();
    expect(parseEmail({})).toBeNull();
  });

  it('passwords', () => {
    expect(passwordProblem('1234567')).toMatch(/al menos 8/);
    expect(passwordProblem('12345678')).toBeNull();
    expect(passwordProblem('ñ'.repeat(40))).toMatch(/superar 72/); // 80 bytes
    expect(passwordProblem(undefined)).not.toBeNull();
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
