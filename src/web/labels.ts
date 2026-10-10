import { MONTHS } from '../domain/dates';
/** Human labels shared by every screen (never internal codes). */
export const SOURCE_LABEL: Record<string, string> = { email: 'Correo del banco', sms: 'SMS', import: 'Mensaje pegado', manual: 'Manual' };
export const STATUS_LABEL: Record<string, string> = { review_required: 'Por revisar', possible_duplicate: 'Posible duplicado', ignored: 'Ignorado' };

/** "2026-09" -> "Septiembre 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const name = MONTHS[m - 1] ?? month;
  return `${name[0]!.toUpperCase()}${name.slice(1)} ${y}`;
}

/** ISO instant -> Lima calendar day label: "15 sep". */
export function limaDayLabel(iso: string): string {
  const d = new Date(Date.parse(iso) - 5 * 3600_000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]!.slice(0, 3)}`;
}

/** ISO instant -> Lima date key "2026-09-15". */
export const limaDateKey = (iso: string) => new Date(Date.parse(iso) - 5 * 3600_000).toISOString().slice(0, 10);
