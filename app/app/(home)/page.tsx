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
import { loadPreferences } from '../../../lib/preferences';
import { alertAllowed } from '../../../src/web/preferences';
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
import { creditSignals, creditUse, spendSlices, type CreditCardFacts } from '../../../src/engine/dashboard';
import { loadCardViews } from '../../../lib/cards';
import { fold } from '../../../src/ai/text';
import { loadSubscriptions } from '../../../lib/subscriptions';
import { nextCharge, subscriptionState, subscriptionTotals } from '../../../src/engine/subscriptions';
import { SubLogo } from '../../../components/sub-logo';

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
  const planningLoad = loadPlanningData(supabase, now);
  // Card reads start at once; an error leaves the card block out instead of breaking Resumen.
  const cardsLoad = loadCardViews(supabase, planningLoad).catch(() => []);
  const subsLoad = loadSubscriptions(supabase).catch(() => null);
  const [txRes, pendingRes, oldestRes, profileRes, budgets, commitmentData, everRes, planning, prefs] = await Promise.all([
    supabase.from('transactions').select(TRANSACTION_SELECT).gte('occurred_at', windowFrom).lt('occurred_at', range.to)
      .order('occurred_at', { ascending: false }).limit(4000),
    supabase.from('transactions').select('id', { count: 'exact', head: true }).in('status', ['review_required', 'possible_duplicate']),
    supabase.from('transactions').select('created_at').in('status', ['review_required', 'possible_duplicate']).order('created_at').limit(1),
    loadProfile(supabase),
    loadBudgets(supabase),
    loadCommitmentData(supabase),
    supabase.from('transactions').select('id', { count: 'exact', head: true }),
    planningLoad,
    loadPreferences(supabase),
  ]);
  const [cards, subsData] = await Promise.all([cardsLoad, subsLoad]);

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
  // Ajustes → Notificaciones: each notice the person turned off is not shown (unusual spending always is).
  const alerts = buildAlerts({ txs: all, pendingCount: 0, oldestPendingDays: null, unresolvedEvents30d: 0, now, currency: 'PEN', budgets: isCurrent ? budgetStatus(all, month, budgets) : [], commitments: soon }).filter((a) => alertAllowed(a.code, prefs));
  const insight = mainInsight(all, month, 'PEN');
  const milestone = isCurrent && prefs.notifyMonthly
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
  const slices = spendSlices(pen.expensesByCategory);
  // The next dated payment of the plan (same line the "Próximos pagos" list shows first).
  const nextPay = available?.lines.filter((l) => (l.kind === 'payment' || l.kind === 'debt' || l.kind === 'overdue') && l.date)
    .sort((a, b) => a.date!.localeCompare(b.date!))[0] ?? null;
  const facts: CreditCardFacts[] = cards.map((c) => ({ name: c.name, currency: c.currency, limitMinor: c.position.limitMinor, usedMinor: c.position.usedMinor }));
  const lines = (['PEN', 'USD'] as const).map((c) => creditUse(facts, c)).filter((x) => x !== null);
  // Overdue = a planned payment past its date with no payment seen (plan engine), per currency, never mixed.
  const plans = isCurrent ? (['PEN', 'USD'] as const).filter((c) => planning.obligations.some((o) => o.currency === c)).map((c) => planFor(planning, c)) : [];
  const overdue = plans.length ? plans.reduce((n, p) => n + p.lines.filter((l) => l.kind === 'overdue').length, 0) : null;
  const signals = isCurrent && (cards.length || overdue !== null) ? creditSignals(facts, overdue) : [];
  // A card already shown above is not repeated as a loan (onboarding may register it in both places).
  const cardNames = new Set(cards.map((c) => fold(c.name)));
  const loans = debts.filter((d) => !cardNames.has(fold(d.name)));
  // Suscripciones: the next charges (planned, from the same engine as Próximos pagos) and the analytical monthly cost.
  const subsSettled = new Map<string, Set<string>>();
  for (const x of subsData?.settlements ?? []) (subsSettled.get(x.obligationId) ?? subsSettled.set(x.obligationId, new Set()).get(x.obligationId)!).add(x.period);
  const subsNext = (subsData?.subs ?? []).filter((x) => subscriptionState(x, today) !== 'ended')
    .map((x) => ({ x, n: nextCharge(x, today, subsSettled.get(x.id) ?? new Set()) })).filter((r) => r.n?.date)
    .sort((a, b) => a.n!.date!.localeCompare(b.n!.date!)).slice(0, 3);
  const subsTotals = subsData ? subscriptionTotals(subsData.subs, subsData.settlements, today) : [];

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
    <main className="dash">
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

      {pendingCount > 0 && prefs.notifyReview && (
        <Link href="/app/revisar" className="notice warning review-alert" data-testid="review-alert">
          <span><strong>{plural(pendingCount, 'movimiento por revisar', 'movimientos por revisar')}</strong>
            <small>Confírmalos para completar tu resumen.</small></span>
          <Icon name="chevron" size={18} />
        </Link>
      )}

      {milestone && <section className="milestone" data-testid="milestone" aria-label="Cierre de mes"><p>{milestone.text}</p></section>}

      {/* Top: what can be used until the next income, then the month in four figures (PEN). */}
      <div className={`dash-top${available ? '' : ' solo'}`}>
        {available && <FreeHero p={available} />}
        <section className="kpis" aria-label={`${monthLabel(month)} en soles`}>
          <div className="kpi"><span>Ingresos</span><strong data-testid="income-PEN">{money(pen.incomeMinor, 'PEN')}</strong><small className="muted">Registrados</small></div>
          <div className="kpi"><span>Gastos</span><strong data-testid="expenses-PEN">{money(pen.expensesMinor, 'PEN')}</strong><small className="muted">Registrados</small></div>
          <div className="kpi"><span>Ahorro</span><strong data-testid="net-PEN">{signed(pen.netCashFlowMinor, 'PEN')}</strong>
            <small className="muted" data-testid={pen.savingsLabel === 'estimated' ? 'data-health' : undefined}>{pen.savingsLabel === 'estimated' ? 'Estimado: hay movimientos por revisar' : 'Ingresos menos gastos'}</small></div>
          {isCurrent && (nextPay ? (
            <Link href="/app/compromisos" className="kpi link-kpi" data-testid="next-payment">
              <span>Próximo pago</span>
              <strong>{nextPay.amountMinor === null ? 'Por confirmar' : money(nextPay.amountMinor, 'PEN')}</strong>
              <small className={nextPay.kind === 'overdue' ? 'error' : 'muted'}>{nextPay.label} · {nextPay.kind === 'overdue' ? `venció el ${shortDate(nextPay.date!)}` : `vence el ${shortDate(nextPay.date!)}`}</small>
            </Link>
          ) : (
            <Link href="/app/compromisos" className="kpi link-kpi" data-testid="next-payment">
              <span>Próximo pago</span><strong>Sin pagos</strong><small className="muted">Agrega tus pagos fijos</small>
            </Link>
          ))}
        </section>
      </div>
      {incomePlan && incomePlan.base && planning.recentIncome && (
        <div className="event-row" data-testid="income-event">
          <span>Entraron <strong>{money(incomePlan.base.amountMinor, 'PEN')}</strong><small className="muted">{planning.recentIncome.merchant ?? 'Ingreso'} · {shortDate(planning.recentIncome.date)}</small></span>
          <Link href={`/app/plan?ingreso=${planning.recentIncome.transactionId}`} className="button">Ver reparto</Link>
        </div>
      )}

      {/* Two columns from 1024 px (what happened | what comes); one prioritized column on a phone (CSS order). */}
      <div className="dash-cols">
        <div className="col">
          {hasTrend && (
            <section className="card stack-sm o-trend" aria-labelledby="h-trend">
              <div className="row"><h2 id="h-trend">Ingresos y gastos</h2><Link href={`/app/analisis?month=${month}`} className="section-link">Análisis<Icon name="chevron" size={16} /></Link></div>
              <TrendBars months={trend} currency="PEN" testId="home-trend" />
              {insight && !isCurrent && <p className="small muted" data-testid="insight">{insight.estimated ? 'Estimado: ' : ''}{insight.text}</p>}
            </section>
          )}

          {slices.length > 0 && (
            <section className="card stack-sm o-spend" aria-labelledby="h-spend" data-testid="spend-slices">
              <div className="row"><h2 id="h-spend">En qué se fue tu dinero</h2><Link href={`/app/analisis?month=${month}`} className="section-link">Detalle<Icon name="chevron" size={16} /></Link></div>
              <small className="muted">Gastos registrados en {monthLabel(month).toLowerCase()} · PEN{pen.savingsLabel === 'estimated' ? ' · sin contar los por revisar' : ''}</small>
              <ul className="plain stack-sm">
                {slices.map((sl) => (
                  <li key={sl.category} className="cat-row">
                    <span>{sl.category}</span><strong className="amount">{money(sl.amountMinor, 'PEN')}</strong>
                    <span className="progress" aria-hidden="true"><span className="fill" style={{ width: `${Math.max(2, sl.ratio * 100)}%` }} /></span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="card stack-sm o-recent" aria-labelledby="h-recent">
            <div className="row"><h2 id="h-recent">Movimientos recientes</h2><Link href={`/app/movimientos?month=${month}`} className="section-link">Ver todos<Icon name="chevron" size={16} /></Link></div>
            {txs.length === 0 ? <p className="muted">Aún no hay movimientos en {monthLabel(month).toLowerCase()}.</p> : (
              <ul className="tx-list" data-testid="tx-list">
                {txs.slice(0, 6).map((t) => <li key={t.id}><TxRow t={t} when={limaDayLabel(t.occurredAt)} /></li>)}
              </ul>
            )}
          </section>
        </div>

        <div className="col">
          {available && <div className="o-coming"><ComingUp p={available} /></div>}
          {commitments.length > 0 && (
            <Link href="/app/compromisos" className="card row link-card o-coming" data-testid="commitments">
              <span className="stack-sm" style={{ gap: 2 }}>
                <strong>Gastos fijos del mes</strong>
                <small className="muted">{Object.entries(fixedTotals).map(([c, v]) => money(v!, c as Currency)).join(' + ')} en {plural(commitments.length, 'pago', 'pagos')}</small>
              </span>
              <Icon name="chevron" size={18} />
            </Link>
          )}

          {alerts.length > 0 && (
            <ul className="plain attention o-alerts" data-testid="alerts" aria-label="Para tener en cuenta">
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

          {isCurrent && subsTotals.length > 0 && (
            <section className="card stack-sm o-subs" aria-labelledby="h-subs" data-testid="home-subscriptions">
              <div className="row"><h2 id="h-subs">Suscripciones</h2><Link href="/app/compromisos/suscripciones" className="section-link">Ver<Icon name="chevron" size={16} /></Link></div>
              <small className="muted">{subsTotals.map((t) => `${money(t.monthlyMinor, t.currency)} al mes (estimado)`).join(' · ')}</small>
              {subsNext.length > 0 && (
                <ul className="plain stack-sm">
                  {subsNext.map(({ x, n }) => (
                    <li key={x.id} className="sub-mini">
                      <SubLogo provider={x.provider} name={x.name} size={32} />
                      <span className="setting-text"><span>{x.name}</span><small className="muted">{n!.overdue ? 'Venció' : 'Cobra'} el {shortDate(n!.date!)}</small></span>
                      <strong className={`amount${n!.amountMinor === null ? ' unknown' : ''}`}>{n!.amountMinor === null ? 'Por confirmar' : money(n!.amountMinor, x.currency)}</strong>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {isCurrent && <div className="o-savings"><SavingsGoal netMinor={pen.netCashFlowMinor} goalMinor={planning.settings.PEN?.savingsGoalMinor ?? null} estimated={pen.savingsLabel === 'estimated'} /></div>}

          {(cards.length > 0 || loans.length > 0) && (
            <section className="card stack-sm o-credit" aria-labelledby="h-debts">
              <div className="row"><h2 id="h-debts">Tarjetas y deudas</h2><Link href="/app/tarjetas" className="section-link">Ver<Icon name="chevron" size={16} /></Link></div>
              {lines.map((l) => (
                <div key={l.currency} className="credit-line" data-testid={`credit-use-${l.currency}`}>
                  <span className="row"><span className="muted small">Línea total · {l.currency}</span><strong className="amount">{money(l.limitMinor, l.currency)}</strong></span>
                  <span className="progress" aria-hidden="true"><span className={`fill${l.ratio >= 0.3 ? ' warning' : ''}`} style={{ width: `${Math.min(100, Math.max(2, l.ratio * 100))}%` }} /></span>
                  <small className="muted">Usas el {Math.round(l.ratio * 100)}% ({money(l.usedMinor, l.currency)}){l.withoutData ? ` · sin dato de ${plural(l.withoutData, 'tarjeta', 'tarjetas')}` : ''}</small>
                </div>
              ))}
              <ul className="plain stack-sm debt-mini" data-testid="home-debts">
                {cards.slice(0, 4).map((c) => (
                  <li key={c.id} data-testid="home-card">
                    <span>{c.name}</span>
                    <strong className={`amount${c.position.billed?.amountMinor == null ? ' unknown' : ''}`}>{c.position.billed?.amountMinor == null ? 'por confirmar' : money(c.position.billed.amountMinor, c.currency)}</strong>
                    <small className="muted" style={{ gridColumn: '1 / -1' }}>
                      {[c.statementDay ? `Cierra el ${c.statementDay}` : null, c.position.billed ? `paga hasta el ${shortDate(c.position.billed.dueDate)}` : c.paymentDay ? `paga hasta el ${c.paymentDay}` : null].filter(Boolean).join(' · ') || 'Faltan sus fechas'}
                    </small>
                  </li>
                ))}
                {loans.slice(0, 4).map((d) => (
                  <li key={d.id}>
                    <span>{d.name}</span><strong className="amount">{money(d.balanceMinor, d.currency)}</strong>
                    <small className="muted" style={{ gridColumn: '1 / -1' }}>
                      {[d.installmentMinor ? `Cuota ${money(d.installmentMinor, d.currency)}` : null, nextDue.get(d.id) ? `vence el ${shortDate(nextDue.get(d.id)!)}` : null,
                        d.installmentsTotal ? `${d.installmentsPaid} de ${d.installmentsTotal} cuotas` : null].filter(Boolean).join(' · ') || 'Saldo pendiente'}
                    </small>
                  </li>
                ))}
              </ul>
              {signals.length > 0 && (
                <div className="credit-health stack-xs" data-testid="credit-health">
                  <h3>Tu salud crediticia</h3>
                  <ul className="plain stack-xs">
                    {signals.map((sg) => <li key={sg.code + sg.text} className={`signal ${sg.level}`}><i aria-hidden="true" />{sg.text}</li>)}
                  </ul>
                  <small className="muted">Con lo que registras en Velsuno. No es tu calificación en Infocorp ni en la SBS.</small>
                </div>
              )}
            </section>
          )}

          {usd && (
            <section className="card o-usd" aria-label="Resumen USD">
              <div className="row"><h2>En dólares</h2></div>
              <div className="kpis three" style={{ marginTop: 8 }}>
                <div className="kpi"><span>Ingresos</span><strong data-testid="income-USD">{money(usd.incomeMinor, 'USD')}</strong></div>
                <div className="kpi"><span>Gastos</span><strong data-testid="expenses-USD">{money(usd.expensesMinor, 'USD')}</strong></div>
                <div className="kpi"><span>Ahorro</span><strong data-testid="net-USD">{signed(usd.netCashFlowMinor, 'USD')}</strong></div>
              </div>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
