import { describe, expect, it } from 'vitest';
import { occurrenceState, type SettlementRow } from '../src/engine/planning';

const row = (status: SettlementRow['status'], amountMinor: number | null = null, period = '2026-10', obligationId = 'rent'): SettlementRow => ({ obligationId, period, status, amountMinor });

describe('occurrence state (ADR-0017): skipped ≠ paid, partial ≠ paid', () => {
  it('no rows → open; a skipped row → skipped (never "Pagado")', () => {
    expect(occurrenceState([], 'rent', '2026-10')).toBe('open');
    expect(occurrenceState([row('skipped')], 'rent', '2026-10')).toBe('skipped');
    expect(occurrenceState([row('skipped')], 'rent', '2026-10', 150000)).not.toBe('paid');
  });

  it('a closing row → paid, whatever the amount (the person said "pago completo")', () => {
    expect(occurrenceState([row('paid', 140000)], 'rent', '2026-10', 150000)).toBe('paid');
    expect(occurrenceState([row('partial', 50000), row('paid', 20000)], 'rent', '2026-10', 150000)).toBe('paid');
  });

  it('partial rows stay partial until the real total reaches a known planned amount', () => {
    expect(occurrenceState([row('partial', 50000)], 'rent', '2026-10', 150000)).toBe('partial');
    expect(occurrenceState([row('partial', 50000), row('partial', 100000)], 'rent', '2026-10', 150000)).toBe('paid');
    // Unknown planned amount: never assumed covered; a row with no readable movement adds nothing.
    expect(occurrenceState([row('partial', 900000)], 'rent', '2026-10', null)).toBe('partial');
    expect(occurrenceState([row('partial', null), row('partial', null)], 'rent', '2026-10', 1)).toBe('partial');
  });

  it('rows of another occurrence or obligation are ignored', () => {
    const rows = [row('paid', 150000, '2026-09'), row('skipped', null, '2026-10', 'net')];
    expect(occurrenceState(rows, 'rent', '2026-10', 150000)).toBe('open');
    expect(occurrenceState(rows, 'net', '2026-10')).toBe('skipped');
  });
});
