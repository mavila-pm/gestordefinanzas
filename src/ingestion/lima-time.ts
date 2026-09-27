const MONTHS: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

/** Peru has no DST: America/Lima is always UTC-05:00. */
export function limaIso(y: number, m: number, d: number, h: number, min: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || h < 0 || h > 23 || min < 0 || min > 59) return null;
  const date = new Date(Date.UTC(y, m - 1, d, h + 5, min));
  // Reject impossible dates such as 31/02.
  const back = new Date(date.getTime() - 5 * 3600_000);
  if (back.getUTCDate() !== d || back.getUTCMonth() !== m - 1) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${y}-${p(m)}-${p(d)}T${p(h)}:${p(min)}:00-05:00`;
}

/** "15 de septiembre de 2026 - 08:30 PM" */
export function parseSpanishLongDate(s: string): string | null {
  const m = /^(\d{1,2}) de ([a-záéíóú]+) de (\d{4})\s*-\s*(\d{1,2}):(\d{2})\s*([AP])\.?\s*M\.?$/i.exec(s.trim());
  if (!m) return null;
  const month = MONTHS[m[2]!.toLowerCase()];
  if (!month) return null;
  let hour = Number(m[4]);
  if (hour < 1 || hour > 12) return null;
  const pm = m[6]!.toUpperCase() === 'P';
  if (hour === 12) hour = pm ? 12 : 0;
  else if (pm) hour += 12;
  return limaIso(Number(m[3]), month, Number(m[1]), hour, Number(m[5]));
}

/** "15/09/2026 20:30" */
export function parseNumericDate(s: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  return limaIso(Number(m[3]), Number(m[2]), Number(m[1]), Number(m[4]), Number(m[5]));
}
