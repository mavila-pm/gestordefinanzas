import Link from 'next/link';
import { plural } from '../../../src/domain/plural';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { formatMoney, type Currency } from '../../../src/domain/money';
import { monthlySummary } from '../../../src/engine/monthly-summary';
import { monthlyTrend, previousMonth } from '../../../src/engine/analysis';
import { buildAlerts } from '../../../src/engine/alerts';
import { dataHealth } from '../../../src/engine/data-health';
import { closedMonthMilestone, mainInsight } from '../../../src/engine/insights';
import { budgetStatus } from '../../../src/engine/budgets';
import { loadBudgets, loadCommitmentData, loadEntitlements, loadProfile } from '../../../lib/queries';
import { historyStart, visibleMonth } from '../../../src/domain/entitlements';
import { preferredName } from '../../../src/domain/profile';
import { loadPlanningData, planFor } from '../../../lib/planning';
import { limaToday, shortDate } from '../../../src/domain/dates';
import { monthCommitments, totalsByCurrency } from '../../../src/engine/commitments';
import { rowToTransaction, TRANSACTION_SELECT, type TransactionRow } from '../../../src/infrastructure/supabase/transaction-row';
import { limaMonth, limaMonthRange } from '../../../src/web/auth-input';
import { TxRow } from '../../../components/tx-row';
import { Icon } from '../../../components/ui/icon';
import { ComingUp, FreeHero } from '../../../components/free-hero';
import { RegisterMenu } from '../../../components/register-menu';
import { SavingsGoal } from '../../../components/savings-goal';
import { TrendBars } from '../../../components/trend-bars';
import { limaDayLabel, monthLabel } from '../../../src/web/labels';

/**
 * Resumen: the situation in a glance — available money, fixed payments, what comes next, savings — then what
 * happened (6-month trend, recent movements) and cards/loans. Depth lives in Análisis; questions and what-ifs in Vels.
 */
export default async function Dashboard({ searchParams }: { searchParams: Promise<{ month?: string; deleted?: string }> }) {
  const { month: requested, deleted } = await searchParams;
  const supabase = await createSupabaseServerClient();
  const now = new Date();
  const currentMonth = limaMonth(now);
  // Free shows a limited history window (§81), decided here on the server; older months show the first visible one.
  const firstMonth = historyStart((await loadEntitlements(supabase, now)).entitlements, currentMonth);
  const month = visibleMonth(requested && limaMonthRange(requested) ? requested : currentMonth, firstMonth);
  const range = limaMonthRange(month)!;
  // Six months for the trend (milestones compare with 2 previous months; alerts look back 90 days).
  const windowFrom = limaMonthRange(previousMonth(month, 5))!.from;
  // RLS scopes every query to the signed-in user; no user_id filter can widen it.
  const [txRes, pendingRes, oldestRes, profileRes, budgets, commitmentData, everRes, planning] = await Promise.all([
    supabase.from('transactions').select(TRANSACTION_SELECT).gte('occurred_at', windowFrom).lt('occurred_at', range.to)
      .order('occurred_at', { ascending: false }).limit(4000),
    supabase.from('transactions').select('id', { count: 'exact', head: true }).in('status', ['review_required', 'possible_duplicate']),
    supabase.from('transactions').select('created_at').in('status', ['review_required', 'possible_duplicate']).order('created_at').limit(1),
    loadProfile(supabase),
    loadBudgets(supabase),
    loadCommitmentData(supabase),
    supabase.from('transactions').select('id', { count: 'exact', head: true }),
    loadPlanningData(supabase, now),
  ]);

  if (txRes.error) {
    return <main className="stack"><p role="alert" className="error">No se pudieron cargar tus movimientos.</p></main>;
  }
  const all = (txRes.data as unknown as TransactionRow[]).map(rowToTransaction);
  const txs = all.filter((t) => t.occurredAt.slice(0, 7) === month);
  const pen = monthlySummary(txs, month, 'PEN');
  const usd = txs.some((t) => t.currency === 'USD') ? monthlySummary(txs, month, 'USD') : null;
  const firstTime = (everRes.count ?? 0) === 0;
  const firstName = preferredName(profileRes);

  const pendingCount = pendingRes.count ?? 0;
  const oldest = oldestRes.data?.[0]?.created_at as string | undefined;
  const oldestPendingDays = oldest ? Math.floor((now.getTime() - Date.parse(oldest)) / 86_400_000) : null;
  const health = dataHealth({ pendingCount, oldestPendingDays, unresolvedEvents30d: 0, automaticSources: 0 });
  const today = limaToday(now);
  const isCurrent = month === currentMonth;
  const commitments = monthCommitments(month, today, commitmentData.fixed, commitmentData.debts);
  const fixedTotals = totalsByCurrency(commitments);
  // "Due soon" looks 3 days ahead, so at month end it must also see the first days of next month.
  const soon = isCurrent ? [...commitments, ...monthCommitments(previousMonth(currentMonth, -1), today, commitmentData.fixed, commitmentData.debts).filter((c) => c.daysUntil <= 3)] : [];
  // The review count has its own line below: the alert list keeps the other signals (due soon, limits, unusual).
  const alerts = buildAlerts({ txs: all, pendingCount: 0, oldestPendingDays: null, unresolvedEvents30d: 0, now, currency: 'PEN', budgets: isCurrent ? budgetStatus(all, month, budgets) : [], commitments: soon });
  const insight = mainInsight(all, month, 'PEN');
  const milestone = isCurrent
    ? closedMonthMilestone(all, previousMonth(currentMonth), 'PEN', { firstName, dataHealthOk: health.level !== 'ACTION_REQUIRED', budgets })
    : null;
  const money = (v: number, currency: Currency) => formatMoney({ amountMinor: Math.abs(v), currency });
  const signed = (v: number, currency: Currency) => `${v < 0 ? '−' : ''}${money(v, currency)}`;
  const available = isCurrent ? planFor(planning, 'PEN') : null;
  const incomePlan = isCurrent && planning.recentIncome?.currency === 'PEN' ? planFor(planning, 'PEN', { transactionId: planning.recentIncome.transactionId }) : null;
  const debts = commitmentData.debts.filter((d) => d.active && d.balanceMinor > 0);
  const nextDue = new Map(commitments.filter((c) => c.kind === 'debt').map((c) => [c.id, c.dueDate]));
  const trend = monthlyTrend(all, month, 'PEN', 6);
  const hasTrend = trend.filter((m) => m.incomeMinor > 0 || m.expensesMinor > 0).length >= 2;

  const head = (
    <header className="home-head">
      <div>
        <h1>{firstName ? `Hola, ${firstName}.` : 'Hola.'}</h1>
        <p className="slogan">Tu dinero, más claro.</p>
      </div>
      <RegisterMenu className="button" />
    </header>
  );

  if (firstTime) {
    return (
      <main className="stack narrow-md" data-testid="welcome">
        {head}
        <section className="card stack-sm">
          <h2>Empieza con tu primer movimiento</h2>
          <p className="muted">Cuéntaselo a Vels con tus palabras o regístralo en un minuto.</p>
          <div><RegisterMenu className="button" /></div>
        </section>
      </main>
    );
  }

  return (
    <main className="stack">
      {deleted === '1' && <p role="status" className="notice positive">Movimiento eliminado.</p>}
      {head}
      {!isCurrent && (
        <div className="row">
          <p className="muted">{monthLabel(month)} · mes cerrado</p>
          <nav className="month-nav" aria-label="Cambiar de mes">
            {(!firstMonth || month > firstMonth) && <Link href={`/app?month=${previousMonth(month)}`} aria-label="Mes anterior"><Icon name="back" /></Link>}
            <Link href={`/app?month=${previousMonth(month, -1)}`} aria-label="Mes siguiente"><Icon name="chevron" /></Link>
          </nav>
        </div>
      )}

      {pendingCount > 0 && (
        <Link href="/app/revisar" className="notice warning review-alert" data-testid="review-alert">
          <span><strong>{plural(pendingCount, 'movimiento por revisar', 'movimientos por revisar')}</strong></span>
          <Icon name="chevron" size={18} />
        </Link>
      )}

      {milestone && <section className="milestone" data-testid="milestone" aria-label="Cierre de mes"><p>{milestone.text}</p></section>}

      {/* 1. Dinero disponible */}
      {available && <FreeHero p={available} />}
      {incomePlan && incomePlan.base && planning.recentIncome && (
        <div className="event-row" data-testid="income-event">
          <span>Entraron <strong>{money(incomePlan.base.amountMinor, 'PEN')}</strong><small className="muted">{planning.recentIncome.merchant ?? 'Ingreso'} · {shortDate(planning.recentIncome.date)}</small></span>
          <Link href={`/app/plan?ingreso=${planning.recentIncome.transactionId}`} className="button">Ver reparto</Link>
        </div>
      )}

      {/* The month in one row: always the same three figures (PEN). */}
      <section className="month-row" aria-label="Tu mes en soles">
        <div className="month-figures">
          <div><span>Ingresos</span><strong data-testid="income-PEN">{money(pen.incomeMinor, 'PEN')}</strong></div>
          <div><span>Gastos</span><strong data-testid="expenses-PEN">{money(pen.expensesMinor, 'PEN')}</strong></div>
          <div><span>Ahorro</span><strong data-testid="net-PEN">{signed(pen.netCashFlowMinor, 'PEN')}</strong></div>
        </div>
        {pen.savingsLabel === 'estimated' && <small className="muted" data-testid="data-health">Estimado: hay movimientos por revisar.</small>}
      </section>

      {/* 2. Gastos fijos */}
      {commitments.length > 0 && (
        <Link href="/app/compromisos" className="card row link-card" data-testid="commitments">
          <span className="stack-sm" style={{ gap: 2 }}>
            <strong>Gastos fijos del mes</strong>
            <small className="muted">{Object.entries(fixedTotals).map(([c, v]) => money(v!, c as Currency)).join(' + ')} en {plural(commitments.length, 'pago', 'pagos')}</small>
          </span>
          <Icon name="chevron" size={18} />
        </Link>
      )}

      {/* 3. Próximos pagos */}
      {available && <ComingUp p={available} />}

      {/* 4. Ahorro */}
      {isCurrent && <SavingsGoal netMinor={pen.netCashFlowMinor} goalMinor={planning.settings.PEN?.savingsGoalMinor ?? null} estimated={pen.savingsLabel === 'estimated'} />}

      {alerts.length > 0 && (
        <ul className="plain attention" data-testid="alerts" aria-label="Para tener en cuenta">
          {alerts.map((a) => (
            <li key={a.code} data-alert={a.code}>
              <Link href={a.href ?? '/app'} className={`item ${a.level.toLowerCase()}`}>
                <Icon name={a.level === 'INFORMATIONAL' ? 'alerts' : 'review'} />
                <span className="text">{a.text}</span>
                <Icon name="chevron" size={18} />
              </Link>
            </li>
          ))}
        </ul>
      )}

      {hasTrend && (
        <section className="card stack-sm" aria-labelledby="h-trend">
          <div className="row"><h2 id="h-trend">Ingresos y gastos</h2><Link href={`/app/analisis?month=${month}`} className="section-link">Análisis<Icon name="chevron" size={16} /></Link></div>
          <TrendBars months={trend} currency="PEN" testId="home-trend" />
          {insight && <p className="small muted" data-testid="insight">{insight.estimated ? 'Estimado: ' : ''}{insight.text}</p>}
        </section>
      )}

      {debts.length > 0 && (
        <section className="card stack-sm" aria-labelledby="h-debts">
          <div className="row"><h2 id="h-debts">Tarjetas y préstamos</h2><Link href="/app/compromisos#deudas" className="section-link">Ver<Icon name="chevron" size={16} /></Link></div>
          <ul className="plain stack-sm debt-mini" data-testid="home-debts">
            {debts.slice(0, 4).map((d) => (
              <li key={d.id}>
                <span>{d.name}</span><strong className="amount">{money(d.balanceMinor, d.currency)}</strong>
                <small className="muted" style={{ gridColumn: '1 / -1' }}>
                  {[d.installmentMinor ? `Cuota ${money(d.installmentMinor, d.currency)}` : null, nextDue.get(d.id) ? `vence el ${shortDate(nextDue.get(d.id)!)}` : null,
                    d.installmentsTotal ? `${d.installmentsPaid} de ${d.installmentsTotal} cuotas` : null].filter(Boolean).join(' · ') || 'Saldo pendiente'}
                </small>
              </li>
            ))}
          </ul>
        </section>
      )}

      {usd && (
        <section className="card" aria-label="Resumen USD">
          <div className="row"><h2>En dólares</h2></div>
          <div className="grid" style={{ marginTop: 8 }}>
            <div><span className="muted small">Ingresos</span><p className="big" data-testid="income-USD">{money(usd.incomeMinor, 'USD')}</p></div>
            <div><span className="muted small">Gastos</span><p className="big" data-testid="expenses-USD">{money(usd.expensesMinor, 'USD')}</p></div>
            <div><span className="muted small">Ahorro</span><p className="big" data-testid="net-USD">{signed(usd.netCashFlowMinor, 'USD')}</p></div>
          </div>
        </section>
      )}

      <section aria-label="Movimientos recientes">
        <div className="row"><h2>Movimientos recientes</h2><Link href={`/app/movimientos?month=${month}`} className="section-link">Ver todos<Icon name="chevron" size={16} /></Link></div>
        {txs.length === 0 ? <p className="muted">Aún no hay movimientos en {monthLabel(month).toLowerCase()}.</p> : (
          <ul className="tx-list" data-testid="tx-list">
            {txs.slice(0, 6).map((t) => <li key={t.id}><TxRow t={t} when={limaDayLabel(t.occurredAt)} /></li>)}
          </ul>
        )}
      </section>
    </main>
  );
}
