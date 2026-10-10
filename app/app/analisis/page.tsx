import Link from 'next/link';
import { plural } from '../../../src/domain/plural';
import { Icon } from '../../../components/ui/icon';
import { TrendBars } from '../../../components/trend-bars';
import { monthLabel } from '../../../src/web/labels';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { formatMoney, type Currency } from '../../../src/domain/money';
import {
  compareMonths, fixedVsVariable, monthlyTrend, percentChange, previousMonth, relevantChanges, savingsProgress, savingsRate, topMerchants,
} from '../../../src/engine/analysis';
import { budgetStatus } from '../../../src/engine/budgets';
import { monthCommitments } from '../../../src/engine/commitments';
import { rowToTransaction, TRANSACTION_SELECT, type TransactionRow } from '../../../src/infrastructure/supabase/transaction-row';
import { limaMonth, limaMonthRange } from '../../../src/web/auth-input';
import { loadBudgets, loadCommitmentData, loadEntitlements } from '../../../lib/queries';
import { historyStart, visibleMonth } from '../../../src/domain/entitlements';
import { limaToday, shortDate } from '../../../src/domain/dates';

const TREND_MONTHS = 6;
const monthsBetween = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));
const shortMonth = (m: string) => monthLabel(m).split(' ')[0]!.toLowerCase();

/** "+21%" / "−8%" / "—" (no base: a new category is not a percentage). Words carry the meaning, not only colour. */
function Pct({ value, goodWhenDown = true }: { value: number | null; goodWhenDown?: boolean }) {
  if (value === null) return <span className="muted">—</span>;
  if (value === 0) return <span className="muted">0%</span>;
  const good = goodWhenDown ? value < 0 : value > 0;
  return <span className={good ? 'ok' : 'warn'}>{value > 0 ? '+' : '−'}{Math.abs(value)}%</span>;
}

/**
 * Análisis: the month in depth. Every number comes from confirmed movements through the engine (financialEffect);
 * PEN and USD are separate sections and never summed. Without enough history a section says so instead of drawing.
 */
export default async function Analysis({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const requested = (await searchParams).month;
  const current = limaMonth();
  const supabase = await createSupabaseServerClient();
  // Free history window (§81), decided on the server: the compared month must be visible too.
  const start = historyStart((await loadEntitlements(supabase)).entitlements, current);
  const floor = start ? previousMonth(start, -1) : null;
  const month = visibleMonth(requested && limaMonthRange(requested) ? requested : current, floor && floor <= current ? floor : start);
  const trendMonths = start ? Math.min(TREND_MONTHS, monthsBetween(start, month) + 1) : TREND_MONTHS;
  const [txRes, settled, budgets, commitmentData, settings] = await Promise.all([
    supabase.from('transactions').select(TRANSACTION_SELECT)
      .gte('occurred_at', limaMonthRange(previousMonth(month, trendMonths - 1))!.from).lt('occurred_at', limaMonthRange(month)!.to)
      .order('occurred_at').limit(6000),
    supabase.from('plan_settlements').select('transaction_id').not('fixed_expense_id', 'is', null).not('transaction_id', 'is', null).limit(1000),
    loadBudgets(supabase),
    loadCommitmentData(supabase),
    supabase.from('planning_settings').select('savings_goal_minor').eq('currency', 'PEN').maybeSingle(),
  ]);
  if (txRes.error) return <main className="stack"><p role="alert" className="error">No se pudo cargar el análisis.</p></main>;
  const txs = (txRes.data as unknown as TransactionRow[]).map(rowToTransaction);
  const fixedIds = new Set((settled.data ?? []).map((r) => r.transaction_id as string));
  const currencies = (['PEN', 'USD'] as const).filter((c, i) => i === 0 || txs.some((t) => t.currency === c));
  const goalMinor = settings.data?.savings_goal_minor == null ? null : Number(settings.data.savings_goal_minor);
  const limits = budgetStatus(txs, month, budgets);
  const debts = commitmentData.debts.filter((d) => d.active && d.balanceMinor > 0);
  const debtDue = monthCommitments(month, limaToday(), [], commitmentData.debts).filter((c) => c.daysUntil >= 0);
  const canGoBack = !floor || month > floor;

  return (
    <main className="stack narrow-md">
      <header className="row">
        <div className="page-head">
          <h1>Análisis</h1>
          <p>{monthLabel(month)} frente a {shortMonth(previousMonth(month))}</p>
        </div>
        <nav className="month-nav" aria-label="Cambiar de mes">
          {canGoBack && <Link href={`/app/analisis?month=${previousMonth(month)}`} aria-label="Mes anterior"><Icon name="back" /></Link>}
          {month < current && <Link href={`/app/analisis?month=${previousMonth(month, -1)}`} aria-label="Mes siguiente"><Icon name="chevron" /></Link>}
        </nav>
      </header>

      {currencies.map((currency) => {
        const cmp = compareMonths(txs, month, currency);
        const s = cmp.current;
        const trend = monthlyTrend(txs, month, currency, trendMonths);
        const months = trend.filter((t) => t.incomeMinor > 0 || t.expensesMinor > 0).length;
        const top = topMerchants(txs, month, currency);
        // The month in progress is partial: a drop against a whole previous month is not real yet, a rise already is.
        const changes = relevantChanges(cmp).filter((c) => month !== current || c.pct > 0);
        const split = fixedVsVariable(txs, month, currency, fixedIds);
        const rate = savingsRate(s);
        const m = (v: number) => formatMoney({ amountMinor: Math.abs(v), currency });
        const signed = (v: number) => `${v < 0 ? '−' : ''}${m(v)}`;
        const cats = cmp.categories.filter((c) => c.currentMinor > 0 || c.previousMinor > 0);
        return (
          <div key={currency} className="stack" data-testid={`analysis-${currency}`}>
            {currency === 'USD' && <h2>En dólares</h2>}

            {/* A. Resumen del mes */}
            <section aria-label={`Resumen del mes ${currency}`} className="card stat-grid">
              <div><span className="muted small">Ingresos</span><p className="big">{m(s.incomeMinor)}</p></div>
              <div><span className="muted small">Gastos</span><p className="big" data-testid={`an-expenses-${currency}`}>{m(s.expensesMinor)}</p></div>
              <div><span className="muted small">Ahorro</span><p className="big" data-testid={`an-net-${currency}`}>{signed(s.netCashFlowMinor)}</p></div>
              <div><span className="muted small">Tasa de ahorro</span><p className="big" data-testid={`an-rate-${currency}`}>{rate === null ? '—' : `${rate}%`}</p></div>
            </section>
            {s.pendingCount > 0 && (
              <p className="notice warning small"><span>{plural(s.pendingCount, 'movimiento por revisar aún no cuenta', 'movimientos por revisar aún no cuentan')}. <Link href="/app/revisar">Revisar</Link></span></p>
            )}

            {/* F. Cambios relevantes */}
            {changes.length > 0 && (
              <section aria-labelledby={`chg-${currency}`} className="stack-sm">
                <h2 id={`chg-${currency}`}>Lo que cambió</h2>
                <ul className="plain stack-sm" data-testid={`an-insight-${currency}`}>{changes.map((c) => <li key={c.category}>{c.text}</li>)}</ul>
              </section>
            )}

            {/* B. Tendencia */}
            <section aria-labelledby={`trend-${currency}`} className="card stack-sm">
              <h2 id={`trend-${currency}`}>Últimos {trendMonths} meses</h2>
              {months >= 2 ? <TrendBars months={trend} currency={currency} /> : <p className="muted">Con un mes más de movimientos verás la tendencia.</p>}
            </section>

            {/* C. Categorías */}
            <section aria-labelledby={`cat-${currency}`} className="stack-sm">
              <h2 id={`cat-${currency}`}>Por categoría</h2>
              {cats.length === 0 ? <p className="muted">Sin gastos confirmados en estos dos meses.</p> : (
                <div className="table-wrap">
                  <table className="data-table" data-testid={`categories-${currency}`}>
                    <thead><tr><th scope="col">Categoría</th><th scope="col">{month === current ? 'Este mes' : shortMonth(month)}</th><th scope="col">{shortMonth(cmp.previous.month)}</th><th scope="col">Cambio</th></tr></thead>
                    <tbody>
                      {cats.map((c) => (
                        <tr key={c.category}><th scope="row">{c.category}</th><td>{m(c.currentMinor)}</td><td className="muted">{m(c.previousMinor)}</td>
                          <td><Pct value={percentChange(c.currentMinor, c.previousMinor)} /></td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* D. Fijos vs variables */}
            {s.expensesMinor > 0 && (
              <section aria-labelledby={`fv-${currency}`} className="card stack-sm" data-testid={`fixed-variable-${currency}`}>
                <h2 id={`fv-${currency}`}>Fijos y variables</h2>
                <div className="split-bar" role="img" aria-label={`Fijos ${m(split.fixedMinor)}, variables ${m(split.variableMinor)}`}>
                  <span className="seg fixed" style={{ flexGrow: split.fixedMinor }} /><span className="seg variable" style={{ flexGrow: split.variableMinor }} />
                </div>
                <dl className="legend-row">
                  <div><dt><i className="fixed" />Fijos</dt><dd>{m(split.fixedMinor)}</dd></div>
                  <div><dt><i className="variable" />Variables</dt><dd>{m(split.variableMinor)}</dd></div>
                </dl>
                {split.fixedMinor === 0 && <small className="muted">Cuando confirmes el pago de un gasto fijo, aparecerá aquí.</small>}
              </section>
            )}

            {/* E. Top comercios */}
            <section aria-labelledby={`top-h-${currency}`} className="stack-sm">
              <h2 id={`top-h-${currency}`}>Dónde gastaste más</h2>
              {top.length === 0 ? <p className="muted">Sin gastos confirmados este mes.</p> : (
                <ol className="list" data-testid={`top-${currency}`}>
                  {top.map((t) => <li key={t.merchant}><span className="setting-text"><span>{t.merchant}</span><small className="muted">{plural(t.count, 'vez', 'veces')}</small></span><span className="amount">{m(t.totalMinor)}</span></li>)}
                </ol>
              )}
            </section>

            {/* G. Ahorro (PEN goal) */}
            {currency === 'PEN' && (
              <section aria-labelledby="sav-h" className="card stack-sm" data-testid="an-savings">
                <div className="row"><h2 id="sav-h">Ahorro</h2><Link href="/app/plan" className="section-link">{goalMinor ? "Cambiar meta" : "Definir meta"}</Link></div>
                {(() => {
                  const p = savingsProgress(s.netCashFlowMinor, goalMinor);
                  return p ? (
                    <>
                      <p className="row" style={{ alignItems: 'baseline' }}><strong>{m(p.savedMinor)} de {m(goalMinor!)}</strong><span className="muted">{Math.round(p.ratio * 100)}%</span></p>
                      <span className="progress" aria-hidden="true"><span className="fill" style={{ width: `${Math.max(2, p.ratio * 100)}%` }} /></span>
                    </>
                  ) : <p className="muted small">Sin meta de ahorro.</p>;
                })()}
                {months >= 2 && (
                  <ul className="list small" aria-label="Ahorro por mes">
                    {trend.slice().reverse().map((t) => (
                      <li key={t.month}><span>{monthLabel(t.month)}</span>
                        <span className={`amount${goalMinor && t.netCashFlowMinor >= goalMinor ? ' ok' : ''}`}>{signed(t.netCashFlowMinor)}</span></li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </div>
        );
      })}

      {/* Límites de gasto (month status) */}
      <section aria-labelledby="lim-h" className="stack-sm">
        <div className="row"><h2 id="lim-h">Límites de gasto</h2><Link href="/app/presupuestos" className="section-link">{limits.length ? 'Editar' : 'Definir'}<Icon name="chevron" size={16} /></Link></div>
        {limits.length === 0 ? <p className="muted small">Define cuánto quieres gastar como máximo en una categoría cada mes.</p> : (
          <ul className="plain budget-list" data-testid="an-limits">
            {limits.map((b) => {
              const lm = (v: number) => formatMoney({ amountMinor: Math.abs(v), currency: b.currency });
              return (
                <li key={`${b.category}|${b.currency}`} className="budget" data-state={b.state}>
                  <div className="row" style={{ alignItems: 'baseline' }}><strong>{b.category}</strong><span className="muted small">{Math.round(b.ratio * 100)}%</span></div>
                  <span className="progress" aria-hidden="true"><span className={`fill ${b.state}`} style={{ width: `${Math.min(100, b.ratio * 100)}%` }} /></span>
                  <small className={b.state === 'exceeded' ? 'error' : 'muted'}>{lm(b.spentMinor)} de {lm(b.amountMinor)}</small>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* H. Deudas */}
      {debts.length > 0 && (
        <section aria-labelledby="debt-h" className="card stack-sm" data-testid="an-debts">
          <div className="row"><h2 id="debt-h">Deudas</h2><Link href="/app/compromisos#deudas" className="section-link">Ver<Icon name="chevron" size={16} /></Link></div>
          {(['PEN', 'USD'] as Currency[]).filter((c) => debts.some((d) => d.currency === c)).map((c) => {
            const mine = debts.filter((d) => d.currency === c);
            const owed = mine.reduce((a, d) => a + d.balanceMinor, 0);
            const monthly = mine.reduce((a, d) => a + (d.installmentMinor ?? 0), 0);
            return (
              <div key={c} className="stat-grid">
                <div><span className="muted small">Deuda pendiente{c === 'USD' ? ' (US$)' : ''}</span><p className="big">{formatMoney({ amountMinor: owed, currency: c })}</p></div>
                <div><span className="muted small">Cuotas al mes</span><p className="big">{monthly ? formatMoney({ amountMinor: monthly, currency: c }) : '—'}</p></div>
              </div>
            );
          })}
          <ul className="list small">
            {debts.map((d) => {
              const due = debtDue.find((x) => x.id === d.id);
              return (
                <li key={d.id}><span className="setting-text"><span>{d.name}</span>
                  <small className="muted">{[d.installmentsTotal ? `${d.installmentsPaid} de ${d.installmentsTotal} cuotas` : null, due ? `próximo pago ${shortDate(due.dueDate)}` : null].filter(Boolean).join(' · ') || 'Saldo pendiente'}</small></span>
                  <span className="amount">{formatMoney({ amountMinor: d.balanceMinor, currency: d.currency })}</span></li>
              );
            })}
          </ul>
        </section>
      )}
    </main>
  );
}
