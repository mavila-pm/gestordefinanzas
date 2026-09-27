import Link from 'next/link';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { formatMoney, type Currency } from '../../../src/domain/money';
import { compareMonths, monthlyTrend, previousMonth, topMerchants } from '../../../src/engine/analysis';
import { rowToTransaction, TRANSACTION_SELECT, type TransactionRow } from '../../../src/infrastructure/supabase/transaction-row';
import { limaMonth, limaMonthRange } from '../../../src/web/auth-input';

const TREND_MONTHS = 6;

function Delta({ minor, currency, goodWhenDown }: { minor: number; currency: Currency; goodWhenDown?: boolean }) {
  if (minor === 0) return <span className="muted">sin cambio</span>;
  const up = minor > 0;
  const good = goodWhenDown ? !up : up;
  return <span className={good ? 'ok' : 'warn'}>{up ? '▲' : '▼'} {formatMoney({ amountMinor: Math.abs(minor), currency })}</span>;
}

export default async function Analysis({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const requested = (await searchParams).month;
  const month = requested && limaMonthRange(requested) ? requested : limaMonth();
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from('transactions').select(TRANSACTION_SELECT)
    .gte('occurred_at', limaMonthRange(previousMonth(month, TREND_MONTHS - 1))!.from).lt('occurred_at', limaMonthRange(month)!.to)
    .order('occurred_at').limit(5000);
  if (error) return <main className="stack"><p role="alert" className="error">No se pudo cargar el análisis.</p></main>;
  const txs = (data as unknown as TransactionRow[]).map(rowToTransaction);
  const currencies = (['PEN', 'USD'] as const).filter((c, i) => i === 0 || txs.some((t) => t.currency === c));

  return (
    <main className="stack">
      <div className="row">
        <h1>Análisis de {month}</h1>
        <span className="actions">
          <Link href={`/app/analisis?month=${previousMonth(month)}`}>← {previousMonth(month)}</Link>
          {month < limaMonth() && <Link href={`/app/analisis?month=${previousMonth(month, -1)}`}>{previousMonth(month, -1)} →</Link>}
        </span>
      </div>
      <p className="muted small">Solo cuentan movimientos confirmados. Pagos de tarjeta, transferencias propias y retiros de efectivo no son gasto;
        las devoluciones reducen el gasto.</p>
      {currencies.map((currency) => {
        const cmp = compareMonths(txs, month, currency);
        const trend = monthlyTrend(txs, month, currency, TREND_MONTHS);
        const max = Math.max(1, ...trend.map((m) => Math.max(m.expensesMinor, m.incomeMinor)));
        const top = topMerchants(txs, month, currency);
        const m = (v: number) => formatMoney({ amountMinor: Math.abs(v), currency });
        return (
          <div key={currency} className="stack" data-testid={`analysis-${currency}`}>
            <section className="card stack-sm" aria-label={`Comparación ${currency}`}>
              <h2>Este mes vs {cmp.previous.month} ({currency})</h2>
              <div className="grid">
                <div><span className="muted">Gastos</span><p className="big" data-testid={`an-expenses-${currency}`}>{m(cmp.current.expensesMinor)}</p><Delta minor={cmp.expensesDeltaMinor} currency={currency} goodWhenDown /></div>
                <div><span className="muted">Ingresos</span><p className="big">{m(cmp.current.incomeMinor)}</p><Delta minor={cmp.incomeDeltaMinor} currency={currency} /></div>
                <div><span className="muted">Ahorro</span><p className="big">{cmp.current.netCashFlowMinor < 0 ? '−' : ''}{m(cmp.current.netCashFlowMinor)}</p><Delta minor={cmp.netDeltaMinor} currency={currency} /></div>
              </div>
              {cmp.current.pendingCount > 0 && <p className="warn small">{cmp.current.pendingCount} movimiento(s) por revisar no están incluidos. <Link href="/app/revisar">Revisar</Link></p>}
            </section>

            <section className="card stack-sm">
              <h2>Gasto por categoría</h2>
              {cmp.categories.length === 0 ? <p className="muted">Sin gastos confirmados en estos dos meses.</p> : (
                <table className="table" data-testid={`categories-${currency}`}>
                  <thead><tr><th>Categoría</th><th>{month}</th><th>{cmp.previous.month}</th><th>Cambio</th></tr></thead>
                  <tbody>{cmp.categories.map((c) => (
                    <tr key={c.category}><td>{c.category}</td><td>{m(c.currentMinor)}</td><td>{m(c.previousMinor)}</td><td><Delta minor={c.deltaMinor} currency={currency} goodWhenDown /></td></tr>
                  ))}</tbody>
                </table>
              )}
            </section>

            <section className="card stack-sm">
              <h2>Dónde se fue más dinero</h2>
              {top.length === 0 ? <p className="muted">Sin gastos confirmados este mes.</p> : (
                <ol className="list" data-testid={`top-${currency}`}>
                  {top.map((t) => <li key={t.merchant}><span>{t.merchant} <small className="muted">({t.count})</small></span><span className="amount">{m(t.totalMinor)}</span></li>)}
                </ol>
              )}
            </section>

            <section className="card stack-sm">
              <h2>Últimos {TREND_MONTHS} meses</h2>
              <ul className="bars" aria-label={`Tendencia ${currency}`}>
                {trend.map((t) => (
                  <li key={t.month}>
                    <span className="bar-label">{t.month}</span>
                    <span className="bar-track">
                      <span className="bar income" style={{ width: `${(t.incomeMinor / max) * 100}%` }} title={`Ingresos ${m(t.incomeMinor)}`} />
                      <span className="bar expense" style={{ width: `${(t.expensesMinor / max) * 100}%` }} title={`Gastos ${m(t.expensesMinor)}`} />
                    </span>
                    <span className="bar-values small"><span className="ok">+{m(t.incomeMinor)}</span> <span className="warn">−{m(t.expensesMinor)}</span></span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        );
      })}
    </main>
  );
}
