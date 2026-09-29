import type { Transaction } from '../domain/types';

/**
 * Why a transaction needs the user's review, in plain language (no internal terms such as parser
 * versions or fingerprints). Combines what the parser reported when the event was ingested
 * (financial_events.detail codes) with the user's CURRENT data, so a reason disappears once fixed
 * (e.g. the card was registered after the notification arrived).
 */
export interface ReviewReason {
  code: string;
  text: string;
}

export interface ReviewContext {
  /** Codes recorded at ingestion for this transaction (comma-separated detail of its financial event). */
  ingestionCodes: readonly string[];
  /** Last 4 digits of the cards the user has registered. */
  registeredCardLast4: readonly string[];
  /** Card linked to the transaction, if any. */
  cardId: string | null;
}

const CATEGORIZABLE = new Set(['expense', 'credit_card_purchase', 'refund', 'reversal']);

const FROM_INGESTION: Record<string, string> = {
  transfer_destination_not_own: 'Transferencia a una cuenta que no reconocemos como tuya: ¿pagaste a otra persona o es una cuenta propia?',
  deposit_origin_unknown: 'Depósito de origen desconocido: confirma si es un ingreso o dinero que vuelve a ti.',
  card_missing: 'La notificación no indica con qué tarjeta se hizo.',
  counterparty_missing: 'La notificación no indica la cuenta de destino.',
  sender_not_verified: 'No pudimos verificar que el mensaje venga de tu banco. Revisa que el movimiento sea real.',
  user_import: 'Importado por ti desde un mensaje pegado: confirma que monto, fecha y tipo sean correctos.',
};

export function reviewReasons(t: Transaction, ctx: ReviewContext): ReviewReason[] {
  const out: ReviewReason[] = [];
  const add = (code: string, text: string) => { if (!out.some((r) => r.code === code)) out.push({ code, text }); };

  if (t.status === 'possible_duplicate') {
    add('possible_duplicate', 'Posible duplicado: se parece a otro movimiento ya registrado (mismo monto y hora cercana).');
  }
  if (t.type === 'unknown' && !ctx.ingestionCodes.includes('transfer_destination_not_own')) {
    add('unknown_type', 'No pudimos determinar qué tipo de movimiento es.');
  }
  for (const code of ctx.ingestionCodes) {
    // For pasted text the unverifiable sender is expected; the import reason already says it.
    if (code === 'sender_not_verified' && ctx.ingestionCodes.includes('user_import')) continue;
    const text = FROM_INGESTION[code];
    if (text) add(code, text);
  }
  if (t.cardLast4 && !ctx.cardId) {
    if (!ctx.registeredCardLast4.includes(t.cardLast4)) add('card_not_registered', `Tarjeta ****${t.cardLast4} no identificada: regístrala para saber si es de crédito o débito.`);
    else add('card_not_linked', `Tarjeta ****${t.cardLast4} sin asociar: elige cuál de tus tarjetas es.`);
  }
  if (CATEGORIZABLE.has(t.type)) {
    if (!t.merchantRaw || ctx.ingestionCodes.includes('merchant_missing')) add('merchant_unknown', 'Comercio desconocido: la notificación no indica dónde se hizo.');
    else if (!t.category || t.category === 'Otros') add('category_uncertain', 'Categoría incierta: no reconocimos el comercio.');
  }
  if (out.length === 0 && t.confidence !== 'high') {
    add('medium_confidence', 'Lectura automática con confianza media: verifica monto, fecha y tipo.');
  }
  if (out.length === 0) add('needs_confirmation', 'Requiere tu confirmación.');
  return out;
}

/** financial_events.detail is "code1,code2" for created/possible_duplicate events. */
export function parseIngestionCodes(detail: string | null | undefined): string[] {
  if (!detail) return [];
  return detail.split(',').map((s) => s.trim()).filter((s) => /^[a-z_]{2,40}$/.test(s));
}
