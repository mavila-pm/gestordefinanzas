import type { SupabaseClient } from '@supabase/supabase-js';
import type { Currency } from '../src/domain/money';
import { matchProvider } from '../src/domain/subscriptions';
import type { SettlementFact, SubscriptionRow } from '../src/engine/subscriptions';

const limaDate = (iso: string) => new Date(Date.parse(iso) - 5 * 3600_000).toISOString().slice(0, 10);

export interface Instrument { id: string; kind: 'card' | 'account'; label: string; currency: Currency }
export interface SubscriptionData {
  subs: SubscriptionRow[];
  settlements: SettlementFact[];
  instruments: Instrument[];
  /** Active obligations that look like a catalogue service but are not marked as subscriptions (convert, never duplicate). */
  candidates: Array<{ id: string; name: string; currency: Currency }>;
}

/** Everything Mis suscripciones needs, read under the person's session (RLS: own rows only). */
export async function loadSubscriptions(supabase: SupabaseClient): Promise<SubscriptionData> {
  const [fx, cards, accounts] = await Promise.all([
    supabase.from('fixed_expenses').select('id,name,kind,currency,amount_minor,amount_status,frequency,anchor_month,due_day,due_day_max,target_day,active,created_at,paused_until,ended_on,provider,card_id,account_id')
      .order('created_at', { ascending: true }).limit(300),
    supabase.from('cards').select('id,alias,last4,kind,currency,active').limit(50),
    supabase.from('accounts').select('id,alias,last4,currency,active').limit(50),
  ]);
  const rows = fx.data ?? [];
  const subs: SubscriptionRow[] = rows.filter((r) => r.kind === 'subscription').map((r) => ({
    id: r.id, source: 'obligation', name: r.name, kind: 'subscription', currency: r.currency, amountMinor: r.amount_minor === null ? null : Number(r.amount_minor),
    amountStatus: r.amount_status, frequency: r.frequency, anchorMonth: r.anchor_month, dueDay: r.due_day, dueDayMax: r.due_day_max, targetDay: r.target_day,
    since: limaDate(r.created_at), active: r.active, pausedUntil: r.paused_until, endedOn: r.ended_on, provider: r.provider, cardId: r.card_id, accountId: r.account_id,
  }));
  const ids = subs.map((s) => s.id);
  const st = ids.length
    ? await supabase.from('plan_settlements').select('fixed_expense_id,period,status,transaction_id,tx:transactions(amount_minor,currency,occurred_at,merchant_raw,status)')
      .in('fixed_expense_id', ids).order('period', { ascending: false }).limit(1000)
    : { data: [] };
  const settlements: SettlementFact[] = ((st.data ?? []) as unknown as Array<{ fixed_expense_id: string; period: string; status: 'paid' | 'skipped'; transaction_id: string | null;
    tx: { amount_minor: number; currency: Currency; occurred_at: string; merchant_raw: string | null; status: string } | null }>).map((x) => {
    // Only a confirmed movement is a real payment; anything else is shown without an amount.
    const tx = x.tx && x.tx.status === 'confirmed' ? x.tx : null;
    return { obligationId: x.fixed_expense_id, period: x.period, status: x.status, transactionId: x.transaction_id,
      amountMinor: tx ? Number(tx.amount_minor) : null, occurredOn: tx ? limaDate(tx.occurred_at) : null, currency: tx?.currency ?? null, merchant: tx?.merchant_raw ?? null };
  });
  const instruments: Instrument[] = [
    ...(cards.data ?? []).filter((c) => c.active).map((c) => ({ id: c.id, kind: 'card' as const, label: `${c.alias} ·· ${c.last4}`, currency: c.currency })),
    ...(accounts.data ?? []).filter((a) => a.active).map((a) => ({ id: a.id, kind: 'account' as const, label: a.last4 ? `${a.alias} ·· ${a.last4}` : a.alias, currency: a.currency })),
  ];
  const candidates = rows.filter((r) => r.kind !== 'subscription' && r.active && !r.ended_on && matchProvider(r.name)).map((r) => ({ id: r.id, name: r.name, currency: r.currency }));
  return { subs, settlements, instruments, candidates };
}
