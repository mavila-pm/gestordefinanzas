/**
 * Calendar days as 'YYYY-MM-DD' strings in Lima time (UTC-5, no DST), and how Velsuno says them. One place for the
 * engine, Vels and every screen: pure arithmetic in UTC, Spanish month names.
 */
export const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'set', 'oct', 'nov', 'dic'];

const toDate = (d: string) => new Date(`${d}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Today in Lima as YYYY-MM-DD. */
export const limaToday = (now: Date = new Date()) => iso(new Date(now.getTime() - 5 * 3600_000));
export const addDays = (d: string, n: number) => iso(new Date(toDate(d).getTime() + n * 86_400_000));
/** Whole days from a to b (negative when b is earlier). */
export const daysBetween = (a: string, b: string) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000);

/** "2026-10-15" → "15 oct" (rows, cards, lists). */
export const shortDate = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS_SHORT[Number(d.slice(5, 7)) - 1]}`;
/** "2026-10-15" → "15 de octubre" (inside a sentence, said like a person). */
export const longDate = (d: string) => `${Number(d.slice(8, 10))} de ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
