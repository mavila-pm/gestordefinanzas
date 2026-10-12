import type { Pool, PoolClient } from 'pg';
import type { SourceChannel, Transaction, TransactionSource } from '../../domain/types';
import { toLimaIso } from '../../ingestion/lima-time';
import {
  DuplicateSourceError, type CandidateQuery, type FinancialEventRecord, type TransactionRepository,
} from '../../engine/repository';

/**
 * PostgreSQL implementation of the persistence port. Runs server-side with a privileged connection
 * (ingestion), so EVERY query filters by user_id explicitly; RLS protects client access.
 */
const SELECT_TX = `
  select t.*, c.name as category_name,
    coalesce((select json_agg(json_build_object(
      'channel', s.channel, 'externalEventId', s.external_event_id, 'parserVersion', s.parser_version,
      'templateVerification', s.template_verification, 'receivedAt', s.received_at) order by s.received_at)
      from public.transaction_sources s where s.transaction_id = t.id and s.user_id = t.user_id), '[]') as sources
  from public.transactions t left join public.categories c on c.id = t.category_id`;

interface TxRow {
  id: string; user_id: string; occurred_at: Date; type: Transaction['type']; direction: Transaction['direction'];
  amount_minor: string; currency: Transaction['currency']; institution_code: Transaction['institution'];
  card_last4: string | null; merchant_raw: string | null; merchant_normalized: string | null; category_name: string | null;
  status: Transaction['status']; confidence: Transaction['confidence']; fingerprint: string;
  original_transaction_id: string | null; duplicate_of_id: string | null;
  sources: Array<Omit<TransactionSource, 'receivedAt'> & { receivedAt: string }>;
}

function toTransaction(r: TxRow): Transaction {
  const amountMinor = Number(r.amount_minor);
  if (!Number.isSafeInteger(amountMinor)) throw new Error('amount out of safe integer range');
  return {
    id: r.id, userId: r.user_id, occurredAt: toLimaIso(r.occurred_at), type: r.type, direction: r.direction,
    amountMinor, currency: r.currency, institution: r.institution_code, cardLast4: r.card_last4,
    merchantRaw: r.merchant_raw, merchantNormalized: r.merchant_normalized, category: r.category_name,
    status: r.status, confidence: r.confidence, fingerprint: r.fingerprint,
    sources: r.sources.map((s) => ({ ...s, receivedAt: new Date(s.receivedAt).toISOString() })),
    originalTransactionId: r.original_transaction_id, duplicateOfId: r.duplicate_of_id,
  };
}

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === '23505';

async function insertSource(c: PoolClient, userId: string, transactionId: string, s: TransactionSource) {
  await c.query(
    `insert into public.transaction_sources (user_id, transaction_id, channel, external_event_id, parser_version, template_verification, received_at)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, transactionId, s.channel, s.externalEventId, s.parserVersion, s.templateVerification, s.receivedAt],
  );
}

export class PgTransactionRepository implements TransactionRepository {
  constructor(private readonly pool: Pool) {}

  private async one(sql: string, params: unknown[]): Promise<Transaction | null> {
    const { rows } = await this.pool.query<TxRow>(sql, params);
    return rows[0] ? toTransaction(rows[0]) : null;
  }

  private async byId(c: Pool | PoolClient, userId: string, id: string): Promise<Transaction> {
    const { rows } = await c.query<TxRow>(`${SELECT_TX} where t.user_id = $1 and t.id = $2`, [userId, id]);
    if (!rows[0]) throw new Error(`transaction ${id} not found`);
    return toTransaction(rows[0]);
  }

  private async inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      const out = await fn(c);
      await c.query('commit');
      return out;
    } catch (e) {
      await c.query('rollback');
      if (isUniqueViolation(e)) throw new DuplicateSourceError();
      throw e;
    } finally {
      c.release();
    }
  }

  findBySource(userId: string, channel: SourceChannel, externalEventId: string) {
    return this.one(`${SELECT_TX} where t.user_id = $1 and exists (select 1 from public.transaction_sources s
      where s.transaction_id = t.id and s.user_id = $1 and s.channel = $2 and s.external_event_id = $3)`, [userId, channel, externalEventId]);
  }

  findByBankOperation(userId: string, institution: string, bankOperationId: string) {
    return this.one(`${SELECT_TX} where t.user_id = $1 and t.institution_code = $2 and t.bank_operation_id = $3
      order by t.created_at limit 1`, [userId, institution, bankOperationId]);
  }

  async findCandidates(q: CandidateQuery) {
    // Current OR bank-reported values: a user correction must not hide the movement from a late second source.
    const { rows } = await this.pool.query<TxRow>(`${SELECT_TX} where t.user_id = $1 and t.institution_code = $2 and t.currency = $4
      and ((t.amount_minor = $3 and t.occurred_at between $5 and $6)
        or (t.reported_amount_minor = $3 and t.reported_occurred_at between $5 and $6)) order by t.created_at`,
    [q.userId, q.institution, q.amountMinor, q.currency, q.from, q.to]);
    return rows.map(toTransaction);
  }

  findRefundOriginal(userId: string, r: Parameters<TransactionRepository['findRefundOriginal']>[1]) {
    return this.one(`${SELECT_TX} where t.user_id = $1 and t.type in ('credit_card_purchase', 'expense')
      and t.institution_code is not distinct from $2 and t.card_last4 is not distinct from $3 and t.currency = $4
      and t.merchant_normalized is not distinct from $5 and t.amount_minor >= $6
      and t.occurred_at <= $7 and t.occurred_at >= ($7::timestamptz - interval '120 days')
      order by t.occurred_at desc limit 1`,
    [userId, r.institution, r.cardLast4, r.currency, r.merchantNormalized, r.amountMinor, r.occurredAt]);
  }

  insert(t: Omit<Transaction, 'id'>, bankOperationId: string | null) {
    return this.inTx(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, institution_code,
           card_last4, card_id, merchant_raw, merchant_normalized, category_id, status, confidence, fingerprint, bank_operation_id,
           original_transaction_id, duplicate_of_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, public.card_for_event($1, $7, $8), $9, $10,
           (select id from public.categories where user_id is null and name = $11), $12, $13, $14, $15, $16, $17)
         returning id`,
        [t.userId, t.occurredAt, t.type, t.direction, t.amountMinor, t.currency, t.institution, t.cardLast4,
          t.merchantRaw, t.merchantNormalized, t.category, t.status, t.confidence, t.fingerprint, bankOperationId,
          t.originalTransactionId, t.duplicateOfId],
      );
      const id = rows[0]!.id;
      for (const s of t.sources) await insertSource(c, t.userId, id, s);
      return this.byId(c, t.userId, id);
    });
  }

  addSource(transactionId: string, source: TransactionSource, patch: Partial<Pick<Transaction, 'merchantRaw' | 'merchantNormalized' | 'category'>>) {
    return this.inTx(async (c) => {
      const { rows } = await c.query<{ user_id: string }>('select user_id from public.transactions where id = $1 for update', [transactionId]);
      const userId = rows[0]?.user_id;
      if (!userId) throw new Error(`transaction ${transactionId} not found`);
      await insertSource(c, userId, transactionId, source);
      if (patch.merchantRaw !== undefined) {
        await c.query(
          `update public.transactions set merchant_raw = $3, merchant_normalized = $4,
             category_id = (select id from public.categories where user_id is null and name = $5)
           where id = $1 and user_id = $2`,
          [transactionId, userId, patch.merchantRaw, patch.merchantNormalized ?? null, patch.category ?? null],
        );
      }
      return this.byId(c, userId, transactionId);
    });
  }

  async recordEvent(e: FinancialEventRecord) {
    await this.pool.query(
      `insert into public.financial_events (user_id, channel, external_event_id, parser_version, outcome, detail, transaction_id)
       values ($1, $2, $3, $4, $5, left($6, 300), $7)`,
      [e.userId, e.channel, e.externalEventId, e.parserVersion, e.outcome, e.detail, e.transactionId],
    );
  }

  async listTransactions(userId: string) {
    const { rows } = await this.pool.query<TxRow>(`${SELECT_TX} where t.user_id = $1 order by t.created_at`, [userId]);
    return rows.map(toTransaction);
  }
}
