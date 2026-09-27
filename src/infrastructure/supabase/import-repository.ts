import type { SupabaseClient } from '@supabase/supabase-js';
import type { SourceChannel, Transaction, TransactionSource } from '../../domain/types';
import {
  DuplicateSourceError, type CandidateQuery, type FinancialEventRecord, type TransactionRepository,
} from '../../engine/repository';
import { rowToTransaction, TRANSACTION_SELECT, type TransactionRow } from './transaction-row';

/**
 * Persistence port for user imports (pasted bank notifications), running with the USER'S session:
 * - reads go through RLS (the user only ever sees their own rows);
 * - writes go only through import_insert_transaction / import_add_source / import_record_event, which force
 *   channel 'import', never insert a confirmed movement, and validate every field (migration 000007).
 * `userId` arguments are ignored for scoping on purpose: RLS decides, not the caller.
 */
export class SupabaseImportRepository implements TransactionRepository {
  constructor(private readonly sb: SupabaseClient) {}

  private async many(q: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<Transaction[]> {
    const { data, error } = await q;
    if (error) throw new Error(`read failed: ${error.message}`);
    return ((data ?? []) as TransactionRow[]).map(rowToTransaction);
  }

  private async byId(id: string): Promise<Transaction | null> {
    return (await this.many(this.sb.from('transactions').select(TRANSACTION_SELECT).eq('id', id).limit(1)))[0] ?? null;
  }

  async findBySource(_userId: string, channel: SourceChannel, externalEventId: string) {
    const { data, error } = await this.sb.from('transaction_sources').select('transaction_id')
      .eq('channel', channel).eq('external_event_id', externalEventId).limit(1);
    if (error) throw new Error(`read failed: ${error.message}`);
    const id = (data?.[0] as { transaction_id?: string } | undefined)?.transaction_id;
    return id ? this.byId(id) : null;
  }

  async findByBankOperation(_userId: string, institution: string, bankOperationId: string) {
    return (await this.many(this.sb.from('transactions').select(TRANSACTION_SELECT)
      .eq('institution_code', institution).eq('bank_operation_id', bankOperationId).order('created_at').limit(1)))[0] ?? null;
  }

  findCandidates(q: CandidateQuery) {
    return this.many(this.sb.from('transactions').select(TRANSACTION_SELECT)
      .eq('institution_code', q.institution).eq('amount_minor', q.amountMinor).eq('currency', q.currency)
      .gte('occurred_at', q.from).lte('occurred_at', q.to).order('created_at').limit(50));
  }

  async findRefundOriginal(_userId: string, r: Parameters<TransactionRepository['findRefundOriginal']>[1]) {
    const from = new Date(Date.parse(r.occurredAt) - 120 * 86_400_000).toISOString();
    let q = this.sb.from('transactions').select(TRANSACTION_SELECT).in('type', ['credit_card_purchase', 'expense'])
      .eq('currency', r.currency).gte('amount_minor', r.amountMinor).lte('occurred_at', r.occurredAt).gte('occurred_at', from);
    q = r.institution ? q.eq('institution_code', r.institution) : q.is('institution_code', null);
    q = r.cardLast4 ? q.eq('card_last4', r.cardLast4) : q.is('card_last4', null);
    q = r.merchantNormalized ? q.eq('merchant_normalized', r.merchantNormalized) : q.is('merchant_normalized', null);
    return (await this.many(q.order('occurred_at', { ascending: false }).limit(1)))[0] ?? null;
  }

  async insert(t: Omit<Transaction, 'id'>, bankOperationId: string | null) {
    const source = t.sources[0];
    if (!source || t.sources.length !== 1) throw new Error('an import inserts exactly one source');
    const { data, error } = await this.sb.rpc('import_insert_transaction', {
      p_tx: {
        type: t.type, direction: t.direction, amount_minor: t.amountMinor, currency: t.currency, occurred_at: t.occurredAt,
        institution_code: t.institution, card_last4: t.cardLast4, merchant_raw: t.merchantRaw, merchant_normalized: t.merchantNormalized,
        category: t.category, status: t.status, confidence: t.confidence, fingerprint: t.fingerprint,
        original_transaction_id: t.originalTransactionId, duplicate_of_id: t.duplicateOfId,
      },
      p_source: sourceJson(source),
      p_bank_operation_id: bankOperationId,
    });
    if (error) throw error.code === '23505' ? new DuplicateSourceError() : new Error(`import insert failed: ${error.message}`);
    const created = await this.byId(data as string);
    if (!created) throw new Error('import insert not readable');
    return created;
  }

  async addSource(transactionId: string, source: TransactionSource, patch: Partial<Pick<Transaction, 'merchantRaw' | 'merchantNormalized' | 'category'>>) {
    const { error } = await this.sb.rpc('import_add_source', {
      p_tx_id: transactionId,
      p_source: sourceJson(source),
      p_patch: patch.merchantRaw !== undefined
        ? { merchant_raw: patch.merchantRaw, merchant_normalized: patch.merchantNormalized ?? null, category: patch.category ?? null }
        : {},
    });
    if (error) throw error.code === '23505' ? new DuplicateSourceError() : new Error(`import add source failed: ${error.message}`);
    const updated = await this.byId(transactionId);
    if (!updated) throw new Error('transaction not readable');
    return updated;
  }

  async recordEvent(e: FinancialEventRecord) {
    const { error } = await this.sb.rpc('import_record_event', {
      p_event: { channel: e.channel, external_event_id: e.externalEventId, parser_version: e.parserVersion, outcome: e.outcome, detail: e.detail, transaction_id: e.transactionId },
    });
    if (error) throw new Error(`import event failed: ${error.message}`);
  }

  listTransactions() {
    return this.many(this.sb.from('transactions').select(TRANSACTION_SELECT).order('created_at'));
  }
}

function sourceJson(s: TransactionSource) {
  if (s.channel !== 'import') throw new Error('only import sources can be written with the user session');
  return { channel: s.channel, external_event_id: s.externalEventId, parser_version: s.parserVersion, template_verification: s.templateVerification, received_at: s.receivedAt };
}
