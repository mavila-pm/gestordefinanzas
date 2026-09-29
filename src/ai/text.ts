import type { Currency } from '../domain/money';

/** Lowercase, accents removed, spaces collapsed: for keyword matching only (amounts are read from the same string). */
export const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

export const APPROX = /\b(como|aprox\w*|mas o menos|unos|unas|alrededor|cerca de|casi|entre|por ahi)\b/;
export const UNKNOWN = /\b(no se|nose|ni idea|aun no|todavia no|despues|luego|no me acuerdo|no recuerdo|mas tarde|no estoy segur[oa]|no lo se|ahorita no)\b/;

export interface Amount { minor: number; currency: Currency | null; approx: boolean; index: number; end: number }
export interface Day { day: number; dayMax: number | null; second: number | null; approx: boolean; index: number; end: number }

/**
 * Day expressions: "el 5", "día 10", "los 15", "como el 10", "entre el 9 y 10", "9-10", "15 y 30", "fin de mes".
 * Returned with their span so the amount parser can skip them.
 */
export function findDays(t: string): Day[] {
  const out: Day[] = [];
  const re = /\b(?:(como|aprox\w*|mas o menos|entre|alrededor del?)\s+)?(?:(?:el|los|dia|dias|cada)\s+)(\d{1,2})(?:\s*(?:y|o|al|a|-|–)\s*(?:el\s+)?(\d{1,2}))?\b(?!\s*(?:[.,]\d|mil|k\b|soles|dolares|%))/g;
  for (const m of t.matchAll(re)) {
    const a = Number(m[2]); const b = m[3] ? Number(m[3]) : null;
    if (a < 1 || a > 31 || (b !== null && (b < 1 || b > 31 || b <= a))) continue;
    const window = b !== null && b - a <= 7;
    out.push({ day: a, dayMax: window ? b : null, second: b !== null && !window ? b : null, approx: !!m[1] || window, index: m.index!, end: m.index! + m[0].length });
  }
  const eom = /\b(a )?fin(es)? de mes\b/.exec(t);
  if (eom) out.push({ day: 30, dayMax: null, second: null, approx: true, index: eom.index, end: eom.index + eom[0].length });
  return out;
}

/**
 * Amounts in Peruvian usage: "5,700", "5700", "S/ 950", "950 soles", "US$ 200", "$200", "2 mil", "2.5k", "1,234.50".
 * A bare number under 10 without a currency or multiplier is never an amount ("2 tarjetas").
 */
export function findAmounts(t: string, skip: Array<{ index: number; end: number }> = []): Amount[] {
  const out: Amount[] = [];
  const re = /(s\/\.?|us\$|\$|usd|pen)?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,3}(?:\.\d{3})+(?!\d)|\d+(?:[.,]\d{1,2})?)(?:\s*(mil|k|lucas?|soles|sol|dolares|dolar|usd|pen)\b)?/g;
  for (const m of t.matchAll(re)) {
    const start = m.index! + (m[0].length - m[0].trimStart().length);
    if (skip.some((s) => start >= s.index && start < s.end)) continue;
    const before = t.slice(Math.max(0, start - 1), start);
    if (/[\d/]/.test(before) && !m[1]) continue;
    let num = m[2]!;
    // "5.700" (dot + 3 digits) is a thousands separator; "5,70" is a decimal comma.
    if (/^\d{1,3}(\.\d{3})+$/.test(num)) num = num.replace(/\./g, '');
    else if (/^\d+,\d{1,2}$/.test(num)) num = num.replace(',', '.');
    else num = num.replace(/,/g, '');
    const [i = '0', d = ''] = num.split('.');
    let minor = Number(i) * 100 + Number(d.padEnd(2, '0').slice(0, 2));
    const unit = m[3];
    let end = m.index! + m[0].length;
    if (unit === 'mil' || unit === 'k' || unit === 'luca' || unit === 'lucas') {
      minor *= 1000;
      // "2 lucas y media" / "3 mil y medio" = 2,500 / 3,500 (never silently 2,000)
      const half = /^\s+y\s+medi[ao]\b/.exec(t.slice(end));
      if (half) { minor += 50_000; end += half[0].length; }
    }
    const marker = m[1];
    const currency: Currency | null = marker === 'us$' || marker === '$' || marker === 'usd' || unit === 'dolares' || unit === 'dolar' || unit === 'usd'
      ? 'USD' : marker || unit === 'soles' || unit === 'sol' || unit === 'pen' ? 'PEN' : null;
    if (!Number.isSafeInteger(minor) || minor <= 0) continue;
    if (!marker && !unit && minor < 1000) continue; // "2 tarjetas", "3 veces"
    const before20 = t.slice(Math.max(0, start - 20), start);
    out.push({ minor, currency, approx: APPROX.test(before20), index: start, end });
  }
  return out;
}

export const LAST4 = /(?:terminad[ao] en|termina en|acaba en|finaliza en|••••|\*{2,}|x{3,})\s*(\d{4})\b/;
