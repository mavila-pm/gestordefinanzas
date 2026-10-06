import Link from 'next/link';
import { plural } from '../../../src/domain/plural';
import { Icon } from '../../../components/ui/icon';
import { mainInsight } from '../../../src/engine/insights';
import { monthLabel } from '../../../src/web/labels';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { formatMoney, type Currency } from '../../../src/domain/money';
import { compareMonths, monthlyTrend, previousMonth, topMerchants } from '../../../src/engine/analysis';
import { rowToTransaction, TRANSACTION_SELECT, type TransactionRow } from '../../../src/infrastructure/supabase/transaction-row';
import { limaMonth, limaMonthRange } from '../../../src/web/auth-input';

const TREND_MONTHS = 6;

const shortMonth = (m: string) => monthLabel(m).split(' ')[0]!.toLowerCase();

/** "S/ 310.00 más que en agosto" — words, not only colour or arrows. */
function Delta({ minor, currency, vs, goodWhenDown }: { minor: number; currency: Currency; vs?: string; goodWhenDown?: boolean }) {
  if (minor === 0) return <span className="muted">{vs ? `igual que en ${vs}` : 'igual'}</span>;
  const up = minor > 0;
  const good = goodWhenDown ? !up : up;
  return <span className={good ? 'ok' : 'warn'}>{formatMoney({ amountMinor: Math.abs(minor), currency })} {up ? 'más' : 'menos'}{vs ? ` que en ${vs}` : ''}</span>;
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

  const current = limaMonth();
  return (
    <main className="stack narrow-md">
      <header className="row">
        <div className="page-head">
          <h1>Qué cambió</h1>
          <p>{monthLabel(month)} frente a {shortMonth(previousMonth(month))}</p>
        </div>
        <nav className="month-nav" aria-label="Cambiar de mes">
          <Link href={`/app/analisis?month=${previousMonth(month)}`} aria-label="Mes anterior"><Icon name="back" /></Link>
          {month < current && <Link href={`/app/analisis?month=${previousMonth(month, -1)}`} aria-label="Mes siguiente"><Icon name="chevron" /></Link>}
        </nav>
      </header>
      {currencies.map((currency) => {
        const cmp = compareMonths(txs, month, currency);
        const trend = monthlyTrend(txs, month, currency, TREND_MONTHS);
        const max = Math.max(1, ...trend.map((t) => Math.max(t.expensesMinor, t.incomeMinor)));
        const top = topMerchants(txs, month, currency);
        const insight = mainInsight(txs, month, currency);
        const vs = shortMonth(cmp.previous.month);
        const m = (v: number) => formatMoney({ amountMinor: Math.abs(v), currency });
        const changed = [...cmp.categories].filter((c) => c.currentMinor > 0 || c.previousMinor > 0).sort((a, b) => Math.abs(b.deltaMinor) - Math.abs(a.deltaMinor));
        return (
          <div key={currency} className="stack" data-testid={`analysis-${currency}`}>
            {currency === 'USD' && <h2>En dólares</h2>}
            {insight && <p className="lead" data-testid={`an-insight-${currency}`}>{insight.estimated ? 'Estimado: ' : ''}{insight.text}</p>}
            <section aria-label={`Comparación ${currency}`} className="figures">
              <div>
                <span className="muted small">Gastaste</span>
                <p className="big" data-testid={`an-expenses-${currency}`}>{m(cmp.current.expensesMinor)}</p>
                <small><Delta minor={cmp.expensesDeltaMinor} currency={currency} vs={vs} goodWhenDown /></small>
              </div>
              <div>
                <span className="muted small">Ingresó</span>
                <p className="big">{m(cmp.current.incomeMinor)}</p>
                <small><Delta minor={cmp.incomeDeltaMinor} currency={currency} vs={vs} /></small>
              </div>
            </section>
            {cmp.current.pendingCount > 0 && (
              <p className="notice warning small"><span>{plural(cmp.current.pendingCount, 'movimiento por revisar aún no cuenta', 'movimientos por revisar aún no cuentan')}. <Link href="/app/revisar">Revisar</Link></span></p>
            )}

            <section aria-labelledby={`cat-${currency}`}>
              <h2 id={`cat-${currency}`}>Por categoría</h2>
              {changed.length === 0 ? <p className="muted">Sin gastos confirmados en estos dos meses.</p> : (
                <ul className="list" data-testid={`categories-${currency}`}>
                  {changed.map((c) => (
                    <li key={c.category}>
                      <span className="setting-text"><span>{c.category}</span><small className="muted"><Delta minor={c.deltaMinor} currency={currency} goodWhenDown /> · antes {m(c.previousMinor)}</small></span>
                      <span className="amount">{m(c.currentMinor)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby={`top-h-${currency}`}>
              <h2 id={`top-h-${currency}`}>Dónde gastaste más</h2>
              {top.length === 0 ? <p className="muted">Sin gastos confirmados este mes.</p> : (
                <ol className="list" data-testid={`top-${currency}`}>
                  {top.map((t) => <li key={t.merchant}><span className="setting-text"><span>{t.merchant}</span><small className="muted">{t.count} {t.count === 1 ? 'vez' : 'veces'}</small></span><span className="amount">{m(t.totalMinor)}</span></li>)}
                </ol>
              )}
            </section>

            <details className="card">
              <summary>Últimos {TREND_MONTHS} meses</summary>
              <ul className="bars" aria-label={`Ingresos y gastos, últimos ${TREND_MONTHS} meses`} style={{ marginTop: 12 }}>
                {trend.map((t) => (
                  <li key={t.month}>
                    <span className="bar-label small">{shortMonth(t.month).slice(0, 3)}</span>
                    <span className="bar-track">
                      <span className="bar income" style={{ width: `${(t.incomeMinor / max) * 100}%` }} />
                      <span className="bar expense" style={{ width: `${(t.expensesMinor / max) * 100}%` }} />
                    </span>
                    <span className="bar-values small"><span className="ok">Ingresó {m(t.incomeMinor)}</span> · <span className="muted">gastó {m(t.expensesMinor)}</span></span>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        );
      })}
      <p className="muted small">Solo cuenta lo confirmado. Pagar la tarjeta, mover dinero entre tus cuentas o retirar efectivo no es gasto; las devoluciones lo reducen.</p>
    </main>
  );
}
