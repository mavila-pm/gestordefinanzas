import { FirstVisitHint } from '../../../components/first-visit-hint';
import Link from 'next/link';
import { DebtsBlock } from '../../../components/debts-block';
import { Icon } from '../../../components/ui/icon';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { loadCommitmentData } from '../../../lib/queries';
import { loadPlanningData } from '../../../lib/planning';
import { loadMoneySources } from '../../../lib/money-sources';
import { formatMoney, parseAmountToMinor, type Currency } from '../../../src/domain/money';
import { compareDebtStrategies } from '../../../src/engine/planning';
import { comparePayoff } from '../../../src/engine/scenarios';
import { limaMonth } from '../../../src/web/auth-input';

export const metadata = { title: 'Deudas' };
const m = (v: number, c: Currency) => formatMoney({ amountMinor: v, currency: c });

/**
 * Deudas (UX audit §2.3): loans and debts with people or institutions, what is left, "Registrar pago", which to pay
 * first; credit cards' used line is shown apart (it is owed too, but it lives with the card). Totals per currency.
 */
export default async function Debts({ searchParams }: { searchParams: Promise<{ cuota?: string }> }) {
  const { cuota } = await searchParams;
  const supabase = await createSupabaseServerClient();
  const [{ debts }, plan, sources] = await Promise.all([loadCommitmentData(supabase), loadPlanningData(supabase), loadMoneySources(supabase)]);
  const active = debts.filter((d) => d.active);
  const month = limaMonth();
  const strategies = compareDebtStrategies(plan.debts.filter((x) => x.currency === 'PEN'));
  const budgetMinor = cuota ? parseAmountToMinor(cuota) : null;
  const installments = new Map(debts.map((d) => [d.id, d.installmentMinor]));
  const payoff = budgetMinor ? comparePayoff(plan.debts.filter((x) => x.currency === 'PEN').map((x) => ({ ...x, minimumMinor: installments.get(x.id) ?? null })), budgetMinor) : null;
  const totals = (['PEN', 'USD'] as Currency[]).map((c) => ({
    c, debt: active.filter((d) => d.currency === c).reduce((s, d) => s + d.balanceMinor, 0),
    monthly: active.filter((d) => d.currency === c && d.balanceMinor > 0).reduce((s, d) => s + (d.installmentMinor ?? 0), 0),
    cards: sources.cards.filter((k) => k.active && k.kind === 'credit' && k.currency === c && k.usedMinor !== null && k.usedMinor > 0).reduce((s, k) => s + (k.usedMinor ?? 0), 0),
  })).filter((t) => t.c === 'PEN' || t.debt || t.cards);

  return (
    <main className="stack">
      <header className="row">
        <div className="page-head"><h1>Deudas</h1><p>Préstamos y deudas con personas o entidades: cuánto falta y qué pagar primero.</p></div>
        <div className="actions"><Link href="/app/preguntar?tema=deuda" className="button quiet"><Icon name="chat" size={18} />Contárselo a Vels</Link></div>
      </header>
      <FirstVisitHint id="deudas">Anota tus préstamos y lo que le debes a personas. Sus cuotas entran a tus próximos pagos y a tu Balance financiero.</FirstVisitHint>

      <section className="liq-grid" aria-label="Total de deudas">
        {totals.map((t) => (
          <section key={t.c} className="card stack-sm" data-testid={`debts-total-${t.c}`}>
            <span className="muted small">Debes en préstamos y deudas{t.c === 'USD' ? ' (dólares)' : ''}</span>
            <strong className="liq-figure">{m(t.debt, t.c)}</strong>
            {t.monthly > 0 && <div className="balance-row"><span>Cuotas al mes</span><span className="amount">{m(t.monthly, t.c)}</span></div>}
            {t.cards > 0 && <div className="balance-row muted"><span>Usado en tarjetas de crédito <small>(aparte)</small></span><span className="amount">{m(t.cards, t.c)}</span></div>}
            <small className="muted">Tus cuotas entran en Próximos pagos y en tu Balance financiero.</small>
          </section>
        ))}
      </section>

      {active.length === 0 && <p className="muted">Sin deudas registradas. Si le debes a alguien o tienes un préstamo, agrégalo: así lo planificamos.</p>}
      <section className="stack-sm" aria-label="Tus deudas">
        <DebtsBlock debts={active} plan={plan} month={month} strategies={strategies} payoff={payoff} cuota={cuota ?? null} />
      </section>
    </main>
  );
}
