import type { SourceChannel, Transaction, TransactionSource } from '../domain/types';

export type EventOutcome =
  | 'created'
  | 'duplicate_same_event'
  | 'merged_cross_source'
  | 'possible_duplicate'
  | 'unresolved'
  | 'non_transactional'
  | 'not_financial'
  | 'rejected';

/** Trace of every raw event received (financial_events), whether or not it became a transaction. */
export interface FinancialEventRecord {
  userId: string;
  channel: Exclude<SourceChannel, 'manual'>;
  externalEventId: string;
  parserVersion: string | null;
  outcome: EventOutcome;
  detail: string | null;
  transactionId: string | null;
}

export interface CandidateQuery {
  userId: string;
  institution: string;
  amountMinor: number;
  currency: string;
  from: string;
  to: string;
}

/** Thrown when a (user, channel, externalEventId) source already exists: Level-1 idempotency under concurrency. */
export class DuplicateSourceError extends Error {
  constructor() { super('duplicate source event'); this.name = 'DuplicateSourceError'; }
}

/** Persistence port. The in-memory version backs unit tests; PostgreSQL implements it next. */
export interface TransactionRepository {
  findBySource(userId: string, channel: SourceChannel, externalEventId: string): Promise<Transaction | null>;
  findByBankOperation(userId: string, institution: string, bankOperationId: string): Promise<Transaction | null>;
  findCandidates(q: CandidateQuery): Promise<Transaction[]>;
  findRefundOriginal(userId: string, t: Pick<Transaction, 'institution' | 'cardLast4' | 'merchantNormalized' | 'amountMinor' | 'currency' | 'occurredAt'>): Promise<Transaction | null>;
  insert(t: Omit<Transaction, 'id'>, bankOperationId: string | null): Promise<Transaction>;
  addSource(transactionId: string, source: TransactionSource, patch: Partial<Pick<Transaction, 'merchantRaw' | 'merchantNormalized' | 'category'>>): Promise<Transaction>;
  recordEvent(e: FinancialEventRecord): Promise<void>;
  listTransactions(userId: string): Promise<Transaction[]>;
}

export class InMemoryTransactionRepository implements TransactionRepository {
  private readonly txs = new Map<string, Transaction & { bankOperationId: string | null }>();
  readonly events: FinancialEventRecord[] = [];
  private seq = 0;

  async findBySource(userId: string, channel: SourceChannel, externalEventId: string) {
    return [...this.txs.values()].find((t) => t.userId === userId
      && t.sources.some((s) => s.channel === channel && s.externalEventId === externalEventId)) ?? null;
  }

  async findByBankOperation(userId: string, institution: string, bankOperationId: string) {
    return [...this.txs.values()].find((t) => t.userId === userId && t.institution === institution
      && t.bankOperationId === bankOperationId) ?? null;
  }

  async findCandidates(q: CandidateQuery) {
    const from = Date.parse(q.from);
    const to = Date.parse(q.to);
    return [...this.txs.values()].filter((t) => t.userId === q.userId && t.institution === q.institution
      && t.amountMinor === q.amountMinor && t.currency === q.currency
      && Date.parse(t.occurredAt) >= from && Date.parse(t.occurredAt) <= to);
  }

  async findRefundOriginal(userId: string, r: Parameters<TransactionRepository['findRefundOriginal']>[1]) {
    const at = Date.parse(r.occurredAt);
    const matches = [...this.txs.values()].filter((t) => t.userId === userId
      && (t.type === 'credit_card_purchase' || t.type === 'expense')
      && t.institution === r.institution && t.cardLast4 === r.cardLast4 && t.currency === r.currency
      && t.merchantNormalized === r.merchantNormalized && t.amountMinor >= r.amountMinor
      && Date.parse(t.occurredAt) <= at && at - Date.parse(t.occurredAt) <= 120 * 86_400_000);
    return matches.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0] ?? null;
  }

  private assertNewSource(userId: string, sources: readonly TransactionSource[]) {
    for (const src of sources) {
      const clash = [...this.txs.values()].some((t) => t.userId === userId
        && t.sources.some((s) => s.channel === src.channel && s.externalEventId === src.externalEventId));
      if (clash) throw new DuplicateSourceError();
    }
  }

  async insert(t: Omit<Transaction, 'id'>, bankOperationId: string | null) {
    this.assertNewSource(t.userId, t.sources);
    const tx = { ...t, id: `tx_${++this.seq}`, bankOperationId };
    this.txs.set(tx.id, tx);
    return tx;
  }

  async addSource(id: string, source: TransactionSource, patch: Partial<Transaction>) {
    const t = this.txs.get(id);
    if (!t) throw new Error(`transaction ${id} not found`);
    this.assertNewSource(t.userId, [source]);
    const next = { ...t, ...patch, sources: [...t.sources, source] };
    this.txs.set(id, next);
    return next;
  }

  async recordEvent(e: FinancialEventRecord) {
    this.events.push(e);
  }

  async listTransactions(userId: string) {
    return [...this.txs.values()].filter((t) => t.userId === userId);
  }
}
