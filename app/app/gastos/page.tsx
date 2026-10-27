import Link from 'next/link';
import { RegisterMenu } from '../../../components/register-menu';
import { TxRow } from '../../../components/tx-row';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { loadPlanningData, planTimeline } from '../../../lib/planning';
import { formatMoney, type Currency } from '../../../src/domain/money';
import { shortDate } from '../../../src/domain/dates';
import { financialEffect } from '../../../src/domain/financial-effect';
import { monthlySummary } from '../../../src/engine/monthly-summary';
import { rowToTransaction, TRANSACTION_SELECT, type TransactionRow } from '../../../src/infrastructure/supabase/transaction-row';
import { limaMonth, limaMonthRange } from '../../../src/web/auth-input';
import { limaDayLabel, monthLabel } from '../../../src/web/labels';

export const metadata = { title: 'Gastos' };
const m = (v: number, c: Currency) => formatMoney({ amountMinor: v, currency: c });

/**
 * Gastos (UX audit §2.3–2.4): spending of the month by category (card purchases count once; card payments, own
 * transfers and ATM withdrawals are not spending), recurring payments and memberships, what comes next, and
 * "Registrar gasto" (Vels already knows it is an expense, or the form comes preset).
 */
export default async function Expenses() {
  const supabase = await createSupabaseServerClient();
  const month = limaMonth();
  const range = limaMonthRange(month)!;
  const [txRes, planning] = await Promise.all([
    supabase.from('transactions').select(TRANSACTION_SELECT).gte('occurred_at', range.from).lt('occurred_at', range.to)
      .order('occurred_at', { ascending: false }).limit(3000),
    loadPlanningData(supabase),
  ]);
  const txs = ((txRes.data ?? []) as unknown as TransactionRow[]).map(rowToTransaction);
  const currencies: Currency[] = (['PEN', 'USD'] as Currency[]).filter((c) => c === 'PEN' || txs.some((t) => t.currency === c));
  const spent = txs.filter((t) => t.status === 'confirmed' && financialEffect(t.type) === 'expense');
  const recurring = planning.obligationRows.filter((o) => o.active);
  const coming = planTimeline(planning).filter((t) => t.kind !== 'income').slice(0, 6);
  const pending = txs.filter((t) => (t.status === 'review_required' || t.status === 'possible_duplicate') && t.direction === 'outflow').length;

  return (
    <main className="stack">
      <header className="row">
        <div className="page-head"><h1>Gastos</h1><p>En qué se va tu dinero, tus pagos fijos y lo que viene.</p></div>
        <div className="actions"><RegisterMenu className="button" kind="expense" /></div>
      </header>

      <section className="liq-grid" aria-label={`Gastos de ${monthLabel(month)}`}>
        {currencies.map((c) => {
          const s = monthlySummary(txs, month, c);
          const cats = Object.entries(s.expensesByCategory).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
          return (
            <section key={c} className="card stack-sm" data-testid={`expense-month-${c}`}>
              <span className="muted small">Gastado en {monthLabel(month).toLowerCase()}{c === 'USD' ? ' (dólares)' : ''}</span>
              <strong className="liq-figure">{m(s.expensesMinor, c)}</strong>
              {cats.length === 0 ? <p className="muted small">Aún no registras gastos este mes.</p> : (
                <div>
                  <span className="muted small">Por categoría</span>
                  {cats.slice(0, 6).map(([name, v]) => (
                    <div key={name} className="balance-row"><span>{name}</span><span className="amount">{m(v, c)}</span></div>
                  ))}
                </div>
              )}
              {s.cashWithdrawalsMinor > 0 && <small className="muted">Retiros de efectivo aparte: {m(s.cashWithdrawalsMinor, c)} (no son gasto; tus gastos en efectivo sí).</small>}
            </section>
          );
        })}
      </section>
      {pending > 0 && <Link href="/app/revisar" className="notice warning"><span>{pending === 1 ? '1 movimiento por revisar aún no cuenta.' : `${pending} movimientos por revisar aún no cuentan.`}</span></Link>}

      <section className="card stack-sm" aria-labelledby="h-fixed">
        <div className="row"><h2 id="h-fixed">Gastos recurrentes y membresías</h2>
          <span className="actions"><Link href="/app/compromisos/suscripciones" className="quiet">Suscripciones</Link><Link href="/app/compromisos" className="quiet">Gestionar</Link></span></div>
        {recurring.length === 0 ? <p className="muted small">Agrega tus pagos fijos (alquiler, luz, internet, Netflix…) para verlos aquí y planificarlos.</p> : recurring.slice(0, 12).map((o) => (
          <div key={o.id} className="balance-row">
            <span className="setting-text"><strong>{o.name}</strong><small className="muted">{o.dueDay ? `Día ${o.dueDay}` : 'Día por confirmar'}{o.amountStatus === 'estimated' ? ' · estimado' : ''}</small></span>
            <span className="amount">{o.amountMinor === null ? 'Por confirmar' : m(o.amountMinor, o.currency)}</span>
          </div>
        ))}
      </section>

      <section className="card stack-sm" aria-labelledby="h-next-pay">
        <div className="row"><h2 id="h-next-pay">Próximos pagos</h2><Link href="/app/compromisos" className="quiet">Ver todos</Link></div>
        {coming.length === 0 ? <p className="muted small">No tienes pagos en las próximas semanas.</p> : coming.map((t) => (
          <div key={`${t.refId}-${t.date}`} className="balance-row">
            <span className="setting-text"><strong>{t.label}</strong><small className={t.overdue ? 'error' : 'muted'}>{t.date ? `${t.overdue ? 'venció el' : 'vence el'} ${shortDate(t.date)}` : 'Día por confirmar'}</small></span>
            <span className="amount">{t.amountMinor === null ? 'Por confirmar' : m(t.amountMinor, t.currency)}</span>
          </div>
        ))}
      </section>

      <section className="card stack-sm" aria-labelledby="h-spent">
        <h2 id="h-spent">Gastos de este mes</h2>
        {spent.length === 0 ? <p className="muted small">Cuando registres un gasto aparecerá aquí.</p> : (
          <ul className="tx-list">{spent.slice(0, 20).map((t) => <li key={t.id}><TxRow t={t} when={limaDayLabel(t.occurredAt)} /></li>)}</ul>
        )}
      </section>
    </main>
  );
}
