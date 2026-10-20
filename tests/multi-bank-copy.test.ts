import { describe, expect, it } from 'vitest';
import { registeredAdapters, supportedInstitutions } from '../src/ingestion/adapter-registry';
import { importOutcomeText, parseImportForm, supportedBanksText } from '../src/web/import-input';
import { joinSpanish, messageFormatLabel, sourceOriginLabel } from '../src/web/labels';
import { ingestRawEvent } from '../src/engine/ingest';
import { InMemoryTransactionRepository } from '../src/engine/repository';

describe('supported banks come from the adapter registry', () => {
  it('BCP and BBVA are read; the Interbank scaffold is registered but not supported', () => {
    expect(registeredAdapters.some((a) => a.institution === 'INTERBANK')).toBe(true);
    expect(supportedInstitutions()).toEqual(['BCP', 'BBVA']);
    expect(supportedInstitutions(registeredAdapters.filter((a) => a.institution !== 'BBVA'))).toEqual(['BCP']);
  });

  it('copy names the supported banks in plain Spanish', () => {
    expect(supportedBanksText()).toBe('BCP y BBVA');
    expect(joinSpanish([])).toBe('');
    expect(joinSpanish(['BCP'])).toBe('BCP');
    expect(joinSpanish(['BCP', 'BBVA', 'Interbank'])).toBe('BCP, BBVA y Interbank');
    expect(importOutcomeText('not_financial').text).toBe('No parece una notificación de un banco soportado (por ahora: BCP y BBVA). No se registró nada.');
    expect(importOutcomeText('plan_limit')).toMatchObject({ ok: false });
  });
});

describe('source origin labels (never the parser version)', () => {
  it('imports say which format was pasted, including app notifications', () => {
    expect(messageFormatLabel('BBVA_PUSH_V1')).toBe('notificación de la app');
    expect(messageFormatLabel('BCP_SMS_V1')).toBe('SMS');
    expect(messageFormatLabel('BBVA_EMAIL_V1')).toBe('email');
    expect(sourceOriginLabel('import', 'BCP_SMS_V1')).toBe('Mensaje del banco importado por ti (SMS)');
    expect(sourceOriginLabel('import', 'BBVA_PUSH_V1')).toBe('Mensaje del banco importado por ti (notificación de la app)');
    expect(sourceOriginLabel('import', 'BCP_EMAIL_V1')).toBe('Mensaje del banco importado por ti (email)');
  });

  it('delivered channels and manual entries', () => {
    expect(sourceOriginLabel('sms', 'BBVA_PUSH_V1')).toBe('Notificación de la app');
    expect(sourceOriginLabel('sms', 'BBVA_SMS_V1')).toBe('Notificación por SMS');
    expect(sourceOriginLabel('email', 'BCP_EMAIL_V1')).toBe('Notificación por email');
    expect(sourceOriginLabel('manual', 'MANUAL')).toBe('Registrado por ti');
    for (const v of ['BBVA_PUSH_V1', 'BCP_SMS_V1', 'BCP_EMAIL_V1']) expect(sourceOriginLabel('import', v)).not.toMatch(/_V\d|BBVA_|BCP_/);
  });

  it('a pasted BBVA app notification (SMS/notification field) is imported with its own format label', async () => {
    const form: Record<string, string> = { channel: 'sms', text: 'BBVA\nCompraste S/ 45.90 en TAMBO MIRAFLORES con tu tarjeta de crédito *1234 el 15/09/2026 a las 20:30.' };
    const parsed = parseImportForm((k) => form[k] ?? null, new Date('2026-09-16T01:31:00Z'));
    if (!parsed.ok) throw new Error(parsed.error);
    const repo = new InMemoryTransactionRepository();
    const ctx = { userId: 'u', ownAccountLast4: [], cards: [], merchantRules: [] };
    expect((await ingestRawEvent(parsed.value, ctx, repo, undefined, { persistAs: 'import' })).outcome).toBe('created');
    const [t] = await repo.listTransactions('u');
    expect(t).toMatchObject({ institution: 'BBVA', status: 'review_required', type: 'credit_card_purchase' });
    expect(sourceOriginLabel(t!.sources[0]!.channel, t!.sources[0]!.parserVersion)).toBe('Mensaje del banco importado por ti (notificación de la app)');
  });
});
