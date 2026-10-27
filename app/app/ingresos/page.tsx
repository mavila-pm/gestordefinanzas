import Link from 'next/link';
import { RegisterMenu } from '../../../components/register-menu';
import { TxRow } from '../../../components/tx-row';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { loadPlanningData, planTimeline } from '../../../lib/planning';
import { formatMoney, type Currency } from '../../../src/domain/money';
import { shortDate } from '../../../src/domain/dates';
import { financialEffect } from '../../../src/domain/financial-effect';
import { monthlySummary } from '../../../src/engine/monthly-summary';
import { incomeBySource } from '../../../src/engine/income-sources';
import { rowToTransaction, TRANSACTION_SELECT, type TransactionRow } from '../../../src/infrastructure/supabase/transaction-row';
import { limaMonth, limaMonthRange } from '../../../src/web/auth-input';
import { limaDayLabel, monthLabel } from '../../../src/web/labels';

export const metadata = { title: 'Ingresos' };
const m = (v: number, c: Currency) => formatMoney({ amountMinor: v, currency: c });
const FREQ: Record<string, string> = { monthly: 'Cada mes', semimonthly: 'Quincenal', biweekly: 'Cada 2 semanas', weekly: 'Cada semana' };

/**
 * Ingresos (UX audit §2.3–2.4): what came in this month and from where, what comes next (expected ≠ received), the
 * recurring incomes, and "Registrar ingreso" (Vels already knows it is an income, or the form comes preset).
 */
export default async function Incomes() {
  const supabase = await createSupabaseServerClient();
  const month = limaMonth();
  const range = limaMonthRange(month)!;
  const [txRes, planning] = await Promise.all([
    supabase.from('transactions').select(TRANSACTION_SELECT).gte('occurred_at', range.from).lt('occurred_at', range.to)
      .in('type', ['income', 'deposit']).order('occurred_at', { ascending: false }).limit(1000),
    loadPlanningData(supabase),
  ]);
  const txs = ((txRes.data ?? []) as unknown as TransactionRow[]).map(rowToTransaction);
  const currencies: Currency[] = (['PEN', 'USD'] as Currency[]).filter((c) => c === 'PEN' || txs.some((t) => t.currency === c) || planning.incomes.some((i) => i.currency === c));
  const coming = planTimeline(planning).filter((t) => t.kind === 'income').slice(0, 6);
  const received = txs.filter((t) => financialEffect(t.type) === 'income');
  const pending = txs.filter((t) => t.status === 'review_required' || t.status === 'possible_duplicate').length;

  return (
    <main className="stack">
      <header className="row">
        <div className="page-head"><h1>Ingresos</h1><p>Lo que entra, de dónde viene y lo que está por llegar.</p></div>
        <div className="actions"><RegisterMenu className="button" kind="income" /></div>
      </header>

      <section className="liq-grid" aria-label={`Ingresos de ${monthLabel(month)}`}>
        {currencies.map((c) => {
          const s = monthlySummary(txs, month, c);
          const sources = incomeBySource(txs, month, c);
          return (
            <section key={c} className="card stack-sm" data-testid={`income-month-${c}`}>
              <span className="muted small">Recibido en {monthLabel(month).toLowerCase()}{c === 'USD' ? ' (dólares)' : ''}</span>
              <strong className="liq-figure">{m(s.incomeMinor, c)}</strong>
              {sources.length === 0 ? <p className="muted small">Aún no registras ingresos este mes.</p> : (
                <div>
                  <span className="muted small">De dónde viene</span>
                  {sources.slice(0, 6).map((x) => (
                    <div key={x.name} className="balance-row"><span>{x.name}{x.count > 1 ? <small className="muted"> · {x.count}</small> : null}</span><span className="amount">{m(x.amountMinor, c)}</span></div>
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </section>
      {pending > 0 && <Link href="/app/revisar" className="notice warning"><span>{pending === 1 ? '1 ingreso por revisar aún no cuenta.' : `${pending} ingresos por revisar aún no cuentan.`}</span></Link>}

      <section className="card stack-sm" aria-labelledby="h-next-inc">
        <div className="row"><h2 id="h-next-inc">Próximos ingresos</h2><Link href="/app/plan" className="quiet">Dinero disponible</Link></div>
        {coming.length === 0 ? <p className="muted small">Agrega tus ingresos fijos para ver cuándo llega el próximo.</p> : coming.map((t) => (
          <div key={`${t.refId}-${t.date}`} className="balance-row">
            <span className="setting-text"><strong>{t.label}</strong><small className="muted">{t.date ? shortDate(t.date) : 'Día por confirmar'} · esperado</small></span>
            <span className="amount">{t.amountMinor === null ? 'Por confirmar' : m(t.amountMinor, t.currency)}{t.amountStatus === 'estimated' ? <small className="muted"> estimado</small> : null}</span>
          </div>
        ))}
      </section>

      <section className="card stack-sm" aria-labelledby="h-rec-inc">
        <h2 id="h-rec-inc">Ingresos recurrentes</h2>
        {planning.incomes.length === 0 ? <p className="muted small">Cuéntale a Vels cuánto y cuándo te pagan, por ejemplo: «me pagan 4500 el 30».</p> : planning.incomes.map((i) => (
          <div key={i.id} className="balance-row">
            <span className="setting-text"><strong>{i.name}</strong><small className="muted">{FREQ[i.frequency] ?? 'Recurrente'}{i.dayOfMonth ? ` · día ${i.dayOfMonth}${i.secondDay ? ` y ${i.secondDay}` : ''}` : ' · día por confirmar'}</small></span>
            <span className="amount">{i.amountMinor === null ? 'Por confirmar' : m(i.amountMinor, i.currency)}</span>
          </div>
        ))}
      </section>

      <section className="card stack-sm" aria-labelledby="h-got">
        <h2 id="h-got">Recibidos este mes</h2>
        {received.length === 0 ? <p className="muted small">Cuando registres un ingreso aparecerá aquí.</p> : (
          <ul className="tx-list">{received.slice(0, 20).map((t) => <li key={t.id}><TxRow t={t} when={limaDayLabel(t.occurredAt)} /></li>)}</ul>
        )}
      </section>
    </main>
  );
}
