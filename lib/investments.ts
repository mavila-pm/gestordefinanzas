import type { SupabaseClient } from '@supabase/supabase-js';
import type { Currency } from '../src/domain/money';
import { position, type InvestmentKind, type InvestmentPosition } from '../src/engine/investments';

export interface InvestmentView {
  id: string; name: string; kind: InvestmentKind; currency: Currency; institution: string | null; annualRateBp: number | null;
  position: InvestmentPosition; entries: { kind: 'contribution' | 'withdrawal' | 'valuation'; amountMinor: number; onDate: string }[];
}

/** Active investments with their position (view investment_positions) and latest entries, under the person's RLS. */
export async function loadInvestments(supabase: SupabaseClient): Promise<InvestmentView[]> {
  const [inv, pos, ent] = await Promise.all([
    supabase.from('investments').select('id,name,kind,currency,institution,annual_rate_bp').eq('active', true).order('created_at').limit(50),
    supabase.from('investment_positions').select('investment_id,contributed_minor,value_minor,value_on').eq('active', true).limit(50),
    supabase.from('investment_entries').select('investment_id,kind,amount_minor,on_date').order('on_date', { ascending: false }).order('created_at', { ascending: false }).limit(300),
  ]);
  const posOf = new Map((pos.data ?? []).map((p) => [p.investment_id, p]));
  return (inv.data ?? []).map((i) => {
    const p = posOf.get(i.id);
    const cur = i.currency as Currency;
    return {
      id: i.id, name: i.name, kind: i.kind as InvestmentKind, currency: cur, institution: i.institution, annualRateBp: i.annual_rate_bp,
      // No aporte or retiro registered = the person never said how much was put in: unknown, never 0.
      position: position(cur, (ent.data ?? []).some((e) => e.investment_id === i.id && e.kind !== 'valuation') && p ? Number(p.contributed_minor) : null, p?.value_minor == null ? null : Number(p.value_minor), p?.value_on ?? null),
      entries: (ent.data ?? []).filter((e) => e.investment_id === i.id).slice(0, 6)
        .map((e) => ({ kind: e.kind, amountMinor: Number(e.amount_minor), onDate: e.on_date })),
    };
  });
}
