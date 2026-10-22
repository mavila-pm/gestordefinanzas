import type { RawFinancialEvent } from '../domain/types';
import type { EventOutcome } from '../engine/repository';
import { MAX_BODY_BYTES } from '../ingestion/sanitize';
import type { Get, Parsed } from './transaction-input';

/**
 * Pasted bank notification. The text is UNTRUSTED input: it is only matched by the bank adapters' fixed patterns
 * and never interpreted as instructions. The sender is marked as a user import, so it can never pass the bank's
 * sender verification (imports are always reviewed).
 */
export function parseImportForm(get: Get, now: Date = new Date()): Parsed<RawFinancialEvent> {
  const channel = get('channel');
  if (channel !== 'sms' && channel !== 'email') return { ok: false, error: 'invalid_request' };
  const body = typeof get('text') === 'string' ? (get('text') as string).replace(/\r\n/g, '\n').trim() : '';
  if (body.length < 10) return { ok: false, error: 'import_empty' };
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return { ok: false, error: 'import_too_large' };
  const subject = typeof get('subject') === 'string' ? (get('subject') as string).trim().slice(0, 300) : '';
  return {
    ok: true,
    value: { channel, sender: `user-import:${channel}`, subject: channel === 'email' ? subject : undefined, body, receivedAt: now.toISOString() },
  };
}

export function importOutcomeText(outcome: EventOutcome): { ok: boolean; text: string } {
  switch (outcome) {
    case 'created': return { ok: true, text: 'Movimiento reconocido. Quedó en "Por revisar" para que lo confirmes.' };
    case 'possible_duplicate': return { ok: true, text: 'Se parece a un movimiento que ya tenías: quedó en "Por revisar" como posible duplicado.' };
    case 'merged_cross_source': return { ok: true, text: 'Ya teníamos este movimiento: se agregó el mensaje como otra fuente (no se duplicó).' };
    case 'duplicate_same_event': return { ok: true, text: 'Ya habías importado este mismo mensaje. No se creó nada nuevo.' };
    case 'non_transactional': return { ok: false, text: 'Es un aviso del banco (estado de cuenta o alerta), no un movimiento. No se registró nada.' };
    case 'unresolved': return { ok: false, text: 'Reconocimos el banco pero no el formato del mensaje. No inventamos datos: regístralo manualmente.' };
    case 'not_financial': return { ok: false, text: 'No parece una notificación de un banco soportado (por ahora: BCP). No se registró nada.' };
    case 'rejected': return { ok: false, text: 'El mensaje es demasiado grande.' };
  }
}
