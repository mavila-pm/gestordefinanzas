import { MONTHS, limaDay } from '../domain/dates';
/** Human labels shared by every screen (never internal codes). */
export const SOURCE_LABEL: Record<string, string> = { email: 'Correo del banco', sms: 'SMS', import: 'Mensaje pegado', manual: 'Manual' };
export const STATUS_LABEL: Record<string, string> = { review_required: 'Por revisar', possible_duplicate: 'Posible duplicado', ignored: 'Ignorado' };
export const INSTITUTION_LABEL: Record<string, string> = { BCP: 'BCP', BBVA: 'BBVA', INTERBANK: 'Interbank' };

/** "A" · "A y B" · "A, B y C". */
export function joinSpanish(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

/** Message format behind a source, read from its parser version (the version itself is never shown). */
export function messageFormatLabel(parserVersion: string): 'SMS' | 'notificación de la app' | 'email' {
  if (/_PUSH_/.test(parserVersion)) return 'notificación de la app';
  if (/_SMS_/.test(parserVersion)) return 'SMS';
  return 'email';
}

const ORIGIN_LABEL: Record<string, string> = {
  email: 'Notificación por email', sms: 'Notificación por SMS', import: 'Mensaje del banco importado por ti', manual: 'Registrado por ti',
};

/** "Origen" line of a movement source: channel, plus the message format for imports and app notifications. */
export function sourceOriginLabel(channel: string, parserVersion: string): string {
  if (channel === 'import') return `${ORIGIN_LABEL.import} (${messageFormatLabel(parserVersion)})`;
  if (channel === 'sms' && messageFormatLabel(parserVersion) === 'notificación de la app') return 'Notificación de la app';
  return ORIGIN_LABEL[channel] ?? ORIGIN_LABEL.manual!;
}

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
export const limaDateKey = limaDay;
