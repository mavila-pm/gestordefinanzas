import type { SupabaseClient } from '@supabase/supabase-js';
import type { Currency } from '../src/domain/money';
import { cardPosition, type CardPosition, type Statement } from '../src/engine/cards';
import { fold } from '../src/ai/text';
import { planFor, type PlanningData } from './planning';

/** ADR-0014: each active credit card's position, read under the person's session (RLS). */
export interface CardView { id: string; name: string; currency: Currency; statement: Statement | null; limitMinor: number | null; statementDay: number | null; paymentDay: number | null; position: CardPosition }

const limaStartOfNextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00-05:00`) + 86_400_000).toISOString();

export async function loadCardViews(supabase: SupabaseClient, d: PlanningData): Promise<CardView[]> {
  const [cards, sts] = await Promise.all([
    supabase.from('cards').select('id,alias,currency,credit_limit_minor,statement_day,payment_day').eq('active', true).eq('kind', 'credit').limit(20),
    supabase.from('card_statements').select('card_id,cut_date,due_date,billed_minor,minimum_minor,used_minor,used_as_of,status,source,updated_at').order('cut_date', { ascending: false }).limit(60),
  ]);
  const latest = new Map<string, Statement>();
  for (const s of sts.data ?? []) if (!latest.has(s.card_id)) latest.set(s.card_id, {
    cutDate: s.cut_date, dueDate: s.due_date, billedMinor: s.billed_minor === null ? null : Number(s.billed_minor), minimumMinor: s.minimum_minor === null ? null : Number(s.minimum_minor),
    usedMinor: s.used_minor === null ? null : Number(s.used_minor), usedAsOf: s.used_as_of, status: s.status, source: s.source, updatedAt: s.updated_at,
  });
  const free: Partial<Record<Currency, number | null>> = {};
  for (const c of cards.data ?? []) if (!(c.currency in free)) free[c.currency as Currency] = planFor(d, c.currency).freeMinor;
  // Post-cut: real purchases on this card after the cut day (Lima), confirmed only. One parallel round.
  const post = await Promise.all((cards.data ?? []).map(async (c) => {
    const st = latest.get(c.id);
    if (!st) return null;
    const { data, error } = await supabase.from('transactions').select('amount_minor').eq('card_id', c.id).eq('type', 'credit_card_purchase')
      .eq('status', 'confirmed').eq('currency', c.currency).gte('occurred_at', limaStartOfNextDay(st.cutDate)).limit(1000);
    return error ? null : (data ?? []).reduce((s, r) => s + Number(r.amount_minor), 0);
  }));
  const out: CardView[] = (cards.data ?? []).map((c, i) => {
    const cur = c.currency as Currency;
    const st = latest.get(c.id) ?? null;
    const debt = d.debts.find((x) => x.currency === cur && fold(x.name) === fold(c.alias));
    return { id: c.id, name: c.alias, currency: cur, statement: st, limitMinor: c.credit_limit_minor === null ? null : Number(c.credit_limit_minor), statementDay: c.statement_day, paymentDay: c.payment_day,
      position: cardPosition(d.today, {
        currency: cur, creditLimitMinor: c.credit_limit_minor === null ? null : Number(c.credit_limit_minor), statementDay: c.statement_day, paymentDay: c.payment_day, annualRateBp: debt?.annualRateBp ?? null,
      }, st, post[i] ?? null, free[cur] ?? null) };
  });
  return out;
}
