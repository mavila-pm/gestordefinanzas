import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, limaToday, longDate, shortDate } from '../src/domain/dates';

describe('one calendar for the engine, Vels and screens (Lima, UTC-5)', () => {
  it('labels: "15 oct" in rows, "15 de octubre" in sentences', () => {
    expect(shortDate('2026-10-15')).toBe('15 oct');
    expect(shortDate('2026-09-01')).toBe('1 set');
    expect(longDate('2026-10-29')).toBe('29 de octubre');
  });
  it('day arithmetic across months and years; Lima today before 5:00 UTC is still yesterday', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(daysBetween('2026-10-09', '2026-10-15')).toBe(6);
    expect(daysBetween('2026-10-15', '2026-10-09')).toBe(-6);
    expect(limaToday(new Date('2026-10-10T04:59:00Z'))).toBe('2026-10-09');
    expect(limaToday(new Date('2026-10-10T05:00:00Z'))).toBe('2026-10-10');
  });
});
