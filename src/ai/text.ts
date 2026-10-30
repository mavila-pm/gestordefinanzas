import type { Currency } from '../domain/money';

/** Lowercase, accents removed, spaces collapsed: for keyword matching only (amounts are read from the same string). */
export const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

/** Approximation words right before an amount: "como 500", "unos S/ 500", "aprox. 500", "más o menos 500". */
export const APPROX_NEAR = /\b(como|aprox\w*|mas o menos|unos|unas|alrededor de|cerca de|casi|por ahi)\.?\s*(de\s+)?(s\/\.?|us\$|\$)?\s*$/;
export const APPROX = /\b(como|aprox\w*|mas o menos|unos|unas|alrededor|cerca de|casi|entre|por ahi)\b/;
export const UNKNOWN = /\b(omitir|no se|nose|ni idea|aun no|todavia no|despues|luego|no me acuerdo|no recuerdo|mas tarde|no estoy segur[oa]|no lo se|ahorita no)\b/;

export interface Amount { minor: number; currency: Currency | null; approx: boolean; index: number; end: number }
export interface Day { day: number; dayMax: number | null; second: number | null; approx: boolean; index: number; end: number }

/**
 * Day expressions: "el 5", "día 10", "los 15", "como el 10", "entre el 9 y 10", "9-10", "15 y 30", "fin de mes".
 * Returned with their span so the amount parser can skip them.
 */
export function findDays(t: string): Day[] {
  const out: Day[] = [];
  // Ordinals count as days: "cada 1ro", "el 1ero", "el 2do", "el 1°".
  const re = /\b(?:(como|aprox\w*|mas o menos|entre|alrededor del?)\s+)?(?:(?:el|los|dia|dias|cada)\s+)(\d{1,2})(?:ro|ero|do|to|vo|no|mo|°|º)?(?:\s*(?:y|o|al|a|-|–)\s*(?:el\s+)?(\d{1,2}))?(?![\w°º])(?!\s*(?:[.,]\d|mil|k\b|soles|dolares|%))/g;
  for (const m of t.matchAll(re)) {
    const a = Number(m[2]); const b = m[3] ? Number(m[3]) : null;
    if (a < 1 || a > 31 || (b !== null && (b < 1 || b > 31 || b <= a))) continue;
    const window = b !== null && b - a <= 7;
    out.push({ day: a, dayMax: window ? b : null, second: b !== null && !window ? b : null, approx: !!m[1] || window, index: m.index!, end: m.index! + m[0].length });
  }
  // "1ro de cada mes", "19 de cada mes", "5 de cada mes": a number + "de cada mes" (or an ordinal) is a day, not money.
  for (const m of t.matchAll(/(?<![\d.,/$])\b(\d{1,2})(ro|ero|do|to|vo|no|mo|°|º)?\s+de\s+(cada|todos los)\s+mes(es)?\b|(?<![\d.,/$])\b(\d{1,2})(ro|ero|°|º)\b/g)) {
    const d = Number(m[1] ?? m[5]);
    if (d < 1 || d > 31 || out.some((x) => x.index <= m.index! && m.index! < x.end)) continue;
    out.push({ day: d, dayMax: null, second: null, approx: false, index: m.index!, end: m.index! + m[0].length });
  }
  const first = /\b(el|cada|los) primero(s)?(?! dias)( de (cada |del? )?mes)?\b/.exec(t);
  if (first && !out.some((d) => d.index <= first.index && first.index < d.end)) {
    out.push({ day: 1, dayMax: null, second: null, approx: false, index: first.index, end: first.index + first[0].length });
  }
  // "el último día del mes": the engine clamps day 31 to the month's real length (28/29/30/31) — exact, not a guess.
  const last = /\b(el )?ultimo dia (del|de cada|de) mes\b/.exec(t);
  if (last) out.push({ day: 31, dayMax: null, second: null, approx: false, index: last.index, end: last.index + last[0].length });
  const eom = !last ? /\b(a )?fin(es)? de mes\b/.exec(t) : null;
  if (eom) out.push({ day: 30, dayMax: null, second: null, approx: true, index: eom.index, end: eom.index + eom[0].length });
  // "los primeros días (del mes)": a window, kept as a window (1–5, estimated), never a made-up exact day.
  const early = /\b(los |en los |a )?primeros dias( del mes| de cada mes| de mes)?\b/.exec(t);
  if (early && !out.length) out.push({ day: 1, dayMax: 5, second: null, approx: true, index: early.index, end: early.index + early[0].length });
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
    // "15 mil soles" / "2 mil dólares": the currency word after the multiplier.
    const tail = unit && !/^(soles|sol|dolares|dolar|usd|pen)$/.test(unit) ? /^\s*(soles|sol|dolares|dolar|usd|pen)\b/.exec(t.slice(end)) : null;
    if (tail) end += tail[0].length;
    const marker = m[1];
    const word = tail?.[1] ?? unit;
    const currency: Currency | null = marker === 'us$' || marker === '$' || marker === 'usd' || word === 'dolares' || word === 'dolar' || word === 'usd'
      ? 'USD' : marker || word === 'soles' || word === 'sol' || word === 'pen' ? 'PEN' : null;
    if (!Number.isSafeInteger(minor) || minor <= 0 || minor > 1e11) continue; // above the DB ceiling: never an amount
    if (!marker && !unit && minor < 1000) continue; // "2 tarjetas", "3 veces"
    // "como 500" / "unos 500" is approximate; "como diseñador … 500" is not (the word must sit right before the number).
    const before20 = t.slice(Math.max(0, start - 20), start);
    out.push({ minor, currency, approx: APPROX_NEAR.test(before20), index: start, end });
  }
  return out;
}

/**
 * Spelled-out amounts in everyday Spanish → digits, on folded text: "ochenta soles" → "80 soles", "dos mil" → "2000",
 * "treinta y cinco" → "35", "dos mil quinientos" → "2500". The result goes through the same amount and day readers, so
 * a spelled number is grounded exactly like a written one (never guessed). "un/una" stay words (articles); slang with
 * regional values ("lucas") is left untouched here.
 */
const UNITS: Record<string, number> = {
  uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14,
  quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiuno: 21, veintiun: 21, veintidos: 22, veintitres: 23,
  veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
};
const TENS: Record<string, number> = { treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90 };
const HUNDREDS: Record<string, number> = {
  cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300, cuatrocientos: 400, cuatrocientas: 400,
  quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600, setecientos: 700, setecientas: 700, ochocientos: 800, ochocientas: 800,
  novecientos: 900, novecientas: 900,
};
const numWord = (w: string) => w in UNITS || w in TENS || w in HUNDREDS || w === 'mil';

export function spelledToDigits(t: string): string {
  const tok = t.match(/[a-zñ]+|[^a-zñ]+/g) ?? [];
  const out: string[] = [];
  for (let i = 0; i < tok.length; i++) {
    if (!numWord(tok[i]!)) { out.push(tok[i]!); continue; }
    // A run of number words separated by single spaces; "y" only joins tens and a unit ("treinta y cinco").
    const run: string[] = [tok[i]!];
    let j = i;
    while (j + 2 < tok.length && tok[j + 1] === ' ') {
      const next = tok[j + 2]!;
      if (numWord(next)) { run.push(next); j += 2; continue; }
      if (next === 'y' && run.at(-1)! in TENS && tok[j + 3] === ' ' && (UNITS[tok[j + 4] ?? ''] ?? 99) <= 9) { run.push(tok[j + 4]!); j += 4; continue; }
      break;
    }
    const after = tok.slice(j + 1, j + 3).join('');
    if (/^\s*lucas?\b/.test(after) || (run.length === 1 && run[0] === 'uno')) { out.push(...tok.slice(i, j + 1)); i = j; continue; }
    let total = 0; let cur = 0; let ok = true;
    for (const w of run) {
      if (w === 'mil') { if (total) { ok = false; break; } total = (cur || 1) * 1000; cur = 0; }
      else cur += UNITS[w] ?? TENS[w] ?? HUNDREDS[w]!;
    }
    if (!ok) { out.push(...tok.slice(i, j + 1)); i = j; continue; }
    out.push(String(total + cur));
    i = j;
  }
  return out.join('');
}

export const LAST4 = /(?:terminad[ao] en|termina en|acaba en|finaliza en|••••|\*{2,}|x{3,})\s*(\d{4})\b/;
