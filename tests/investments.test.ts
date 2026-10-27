import { describe, expect, it } from 'vitest';
import { position, totals } from '../src/engine/investments';

describe('investments (manual tracking)', () => {
  it('gain only with a known value; never the contributed amount as value', () => {
    expect(position('PEN', 100000, null, null)).toEqual({ currency: 'PEN', contributedMinor: 100000, valueMinor: null, valueOn: null, gainMinor: null, gainBp: null });
    expect(position('PEN', 100000, 112000, '2026-10-20')).toMatchObject({ gainMinor: 12000, gainBp: 1200 });
    expect(position('PEN', 100000, 90000, '2026-10-20')).toMatchObject({ gainMinor: -10000, gainBp: -1000 });
    expect(position('PEN', 0, 500, '2026-10-20').gainBp).toBeNull();
    // Never said how much was put in: no gain is invented from the whole value.
    expect(position('PEN', null, 215000, '2026-10-20')).toMatchObject({ contributedMinor: null, gainMinor: null, gainBp: null });
  });
  it('totals per currency; a total value only when every one is known', () => {
    const items = [position('PEN', 100, 120, 'd'), position('PEN', 50, null, null), position('USD', 10, 11, 'd')];
    expect(totals(items, 'PEN')).toEqual({ contributedMinor: 150, valueMinor: null, missingValue: 1, missingContributed: 0 });
    expect(totals(items, 'USD')).toEqual({ contributedMinor: 10, valueMinor: 11, missingValue: 0, missingContributed: 0 });
    expect(totals([], 'PEN')).toEqual({ contributedMinor: 0, valueMinor: null, missingValue: 0, missingContributed: 0 });
    expect(totals([position('PEN', null, 5, 'd')], 'PEN')).toMatchObject({ contributedMinor: null, missingContributed: 1 });
  });
});
