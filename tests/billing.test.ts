import { describe, expect, it } from 'vitest';
import { annualSavingPercent, isPlanCode, limaDatePlus } from '../src/domain/billing';

describe('billing (pure)', () => {
  it('annual saving only when it really saves', () => {
    expect(annualSavingPercent(400, 5900)).toBeNull(); // launch: 12 × US$ 4 = 48 < 59
    expect(annualSavingPercent(900, 5900)).toBe(45); // from 2027: 12 × US$ 9 = 108
  });
  it('plan codes are validated (untrusted form input)', () => {
    expect(isPlanCode('annual')).toBe(true);
    expect(isPlanCode('weekly')).toBe(false);
    expect(isPlanCode(undefined)).toBe(false);
  });
  it('trial end date in Lima', () => {
    expect(limaDatePlus(new Date('2026-10-12T03:00:00Z'), 14)).toBe('2026-10-25');
  });
});
