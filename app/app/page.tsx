import Link from 'next/link';
import { createSupabaseServerClient } from '../../lib/supabase/server';
import { formatMoney, type Currency } from '../../src/domain/money';
import { monthlySummary } from '../../src/engine/monthly-summary';
import { previousMonth } from '../../src/engine/analysis';
import { buildAlerts } from '../../src/engine/alerts';
import { dataHealth } from '../../src/engine/data-health';
import { closedMonthMilestone, mainInsight } from '../../src/engine/insights';
import { budgetStatus } from '../../src/engine/budgets';
import { loadBudgets, loadCommitmentData, loadProfile } from '../../lib/queries';
import { preferredName } from '../../src/domain/profile';
import { loadPlanningData, planFor } from '../../lib/planning';
import { shortDate } from '../../src/web/dates';
import { monthCommitments, totalsByCurrency } from '../../src/engine/commitments';
import { rowToTransaction, TRANSACTION_SELECT, type TransactionRow } from '../../src/infrastructure/supabase/transaction-row';
import { limaMonth, limaMonthRange } from '../../src/web/auth-input';
import { TxRow } from '../../components/tx-row';
import { ActionForm } from '../../components/action-form';
import { ProfileFields } from '../../components/profile-fields';
import { saveProfileAction } from './actions';
import { Icon } from '../../components/ui/icon';
import { limaDayLabel, monthLabel } from '../../src/web/labels';

const CURRENCIES: Currency[] = ['PEN', 'USD'];

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ month?: string; deleted?: string }> }) {
  const { month: requested, deleted } = await searchParams;
  const month = requested && limaMonthRange(requested) ? requested : limaMonth();
  const range = limaMonthRange(month)!;

  const supabase = await createSupabaseServerClient();
  const now = new Date();
  const currentMonth = limaMonth(now);
  // Window: 3 months before the viewed month (milestones compare with 2 previous months; alerts look back 90 days).
  const windowFrom = limaMonthRange(previousMonth(month, 3))!.from;
  const since30 = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  // RLS scopes every query to the signed-in user; no user_id filter can widen it.
  const [txRes, pendingRes, oldestRes, unresolvedRes, autoRes, profileRes, budgets, commitmentData, everRes, planning] = await Promise.all([
    supabase.from('transactions').select(TRANSACTION_SELECT).gte('occurred_at', windowFrom).lt('occurred_at', range.to)
      .order('occurred_at', { ascending: false }).limit(3000),
    supabase.from('transactions').select('id', { count: 'exact', head: true }).in('status', ['review_required', 'possible_duplicate']),
    supabase.from('transactions').select('created_at').in('status', ['review_required', 'possible_duplicate']).order('created_at').limit(1),
    supabase.from('financial_events').select('id', { count: 'exact', head: true }).eq('outcome', 'unresolved').gte('created_at', since30),
    supabase.from('transaction_sources').select('id', { count: 'exact', head: true }).in('channel', ['email', 'sms']).gte('received_at', since30),
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
  const summaries = CURRENCIES.map((c) => monthlySummary(txs, month, c)).filter((s, i) => i === 0 || txs.some((t) => t.currency === s.currency));

  const pendingCount = pendingRes.count ?? 0;
  const oldest = oldestRes.data?.[0]?.created_at as string | undefined;
  const oldestPendingDays = oldest ? Math.floor((now.getTime() - Date.parse(oldest)) / 86_400_000) : null;
  const unresolvedEvents30d = unresolvedRes.count ?? 0;
  const health = dataHealth({ pendingCount, oldestPendingDays, unresolvedEvents30d, automaticSources: (autoRes.count ?? 0) > 0 ? 1 : 0 });
  const budgetsNow = budgetStatus(all, month, budgets);
  const todayLima = new Date(now.getTime() - 5 * 3600_000).toISOString().slice(0, 10);
  const commitments = monthCommitments(month, todayLima, commitmentData.fixed, commitmentData.debts);
  const commitmentTotals = totalsByCurrency(commitments);
  const alerts = buildAlerts({ txs: all, pendingCount, oldestPendingDays, unresolvedEvents30d, now, currency: 'PEN', budgets: month === currentMonth ? budgetsNow : [], commitments: month === currentMonth ? commitments : [] });
  const insight = mainInsight(all, month, 'PEN');
  // Milestones are event-driven: only the month that just closed, shown while viewing the current month.
  const firstName = preferredName(profileRes);
  const milestone = month === currentMonth
    ? closedMonthMilestone(all, previousMonth(currentMonth), 'PEN', { firstName, dataHealthOk: health.level !== 'ACTION_REQUIRED', budgets })
    : null;
  const HEALTH_LABEL = { HEALTHY: 'Datos al día', PARTIAL: 'Datos parciales', ACTION_REQUIRED: 'Requiere tu acción' } as const;
  const pen = summaries[0]!;
  const others = summaries.slice(1);
  const money = (v: number, currency: Currency) => formatMoney({ amountMinor: Math.abs(v), currency });
  const nextCommitment = commitments.find((c) => c.daysUntil >= 0);
  const categories = Object.entries(pen.expensesByCategory).sort((a, b) => b[1] - a[1]);
  const topCategory = categories[0]?.[1] ?? 0;
  const firstTime = (everRes.count ?? 0) === 0;

  if (firstTime) return <Welcome name={firstName} />;
  const free = month === currentMonth ? planFor(planning, 'PEN') : null;
  const incomePlan = month === currentMonth && planning.recentIncome?.currency === 'PEN' ? planFor(planning, 'PEN', { transactionId: planning.recentIncome.transactionId }) : null;

  return (
    <main className="stack">
      {deleted === '1' && <p role="status" className="notice positive">Movimiento eliminado.</p>}
      <header className="row">
        <div className="page-head">
          <h1>{month === currentMonth ? (firstName ? `Tu mes, ${firstName}` : 'Tu mes') : monthLabel(month)}</h1>
          <p>{month === currentMonth ? monthLabel(month) : 'Mes cerrado'} · Soles</p>
        </div>
        <nav className="month-nav" aria-label="Cambiar de mes">
          <Link href={`/app?month=${previousMonth(month)}`} aria-label="Mes anterior"><Icon name="back" /></Link>
          {month < currentMonth && <Link href={`/app?month=${previousMonth(month, -1)}`} aria-label="Mes siguiente"><Icon name="chevron" /></Link>}
        </nav>
      </header>

      {milestone && <section className="milestone" data-testid="milestone" aria-label="Cierre de mes"><p>{milestone.text}</p></section>}

      <section className="hero" aria-label="Resumen en soles">
        <span className="label">Flujo neto del mes</span>
        <p className="figure" data-testid="net-PEN">{pen.netCashFlowMinor < 0 ? '−' : ''}{money(pen.netCashFlowMinor, 'PEN')}</p>
        <div data-testid="data-health" className="stack-sm" style={{ gap: 6 }}>
          <span className={`state ${health.level.toLowerCase()}`}>{HEALTH_LABEL[health.level]}</span>
          <small style={{ opacity: .82 }}>
            {pen.savingsLabel === 'confirmed' ? 'Ahorro confirmado' : 'Ahorro estimado'}
            {health.reasons.length > 0 && <>: {health.reasons.join('; ')}</>}
          </small>
        </div>
        <div className="split">
          <div><span className="label">Ingresos</span><p className="value" data-testid="income-PEN">{money(pen.incomeMinor, 'PEN')}</p></div>
          <div><span className="label">Gastos</span><p className="value" data-testid="expenses-PEN">{money(pen.expensesMinor, 'PEN')}</p></div>
        </div>
        {pen.cashWithdrawalsMinor > 0 && <small style={{ opacity: .82 }}>Retiros de efectivo: {money(pen.cashWithdrawalsMinor, 'PEN')}. No cuentan como gasto hasta que sepas en qué se usaron.</small>}
      </section>

      {free && (
        <Link href="/app/plan" className="free-row" data-testid="free-summary">
          {free.freeMinor !== null ? (
            <>
              <span className="setting-text">
                <span className="muted small">{free.status === 'confirmed' ? 'Dinero libre' : 'Dinero libre estimado'}{free.nextIncome ? ` hasta el ${shortDate(free.nextIncome.date)}` : ''}</span>
                <strong className="big">{free.freeMinor < 0 ? 'Faltan ' : ''}{money(free.freeMinor, 'PEN')}</strong>
                <small className="muted">Ya descontamos {money(free.reservedMinor, 'PEN')} en próximos pagos.{free.missing.length ? ` ${free.missing.length === 1 ? 'Falta 1 dato' : `Faltan ${free.missing.length} datos`} por confirmar.` : ''}</small>
              </span>
              <Icon name="chevron" />
            </>
          ) : (
            <>
              <span className="setting-text"><strong>¿Cuánto puedes gastar sin tocar lo que debes pagar?</strong><small className="muted">Calcula tu dinero libre con dos datos.</small></span>
              <Icon name="chevron" />
            </>
          )}
        </Link>
      )}

      {incomePlan && incomePlan.base && planning.recentIncome && (
        <p className="notice positive" data-testid="income-event">
          <span>Entraron <strong>{money(incomePlan.base.amountMinor, 'PEN')}</strong> el {shortDate(planning.recentIncome.date)}.
{' '}
            <Link href={`/app/plan?ingreso=${planning.recentIncome.transactionId}`}>Ver distribución</Link></span>
        </p>
      )}

      {others.map((s) => (
        <section key={s.currency} className="card" aria-label={`Resumen ${s.currency}`}>
          <div className="row"><h2>En dólares</h2><small className="muted">No se suma a soles</small></div>
          <div className="grid" style={{ marginTop: 8 }}>
            <div><span className="muted small">Ingresos</span><p className="big" data-testid={`income-${s.currency}`}>{money(s.incomeMinor, s.currency)}</p></div>
            <div><span className="muted small">Gastos</span><p className="big" data-testid={`expenses-${s.currency}`}>{money(s.expensesMinor, s.currency)}</p></div>
            <div><span className="muted small">Flujo neto</span><p className="big" data-testid={`net-${s.currency}`}>{s.netCashFlowMinor < 0 ? '−' : ''}{money(s.netCashFlowMinor, s.currency)}</p></div>
          </div>
        </section>
      ))}

      {(alerts.length > 0 || insight) && (
        <section aria-label="Necesita tu atención" className="stack-sm">
          {alerts.length > 0 && <h2>Necesita tu atención</h2>}
          {alerts.length > 0 && (
            <ul className="plain attention" data-testid="alerts">
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
          {insight && <p className="insight muted" data-testid="insight" style={{ paddingTop: 8 }}>{insight.estimated ? 'Estimado: ' : ''}{insight.text}</p>}
        </section>
      )}

      {commitments.length > 0 && (
        <section data-testid="commitments" aria-label="Compromisos del mes" className="row card">
          <div className="stack-sm" style={{ gap: 2 }}>
            <h2>Pagos del mes</h2>
            <small className="muted">{Object.entries(commitmentTotals).map(([c, v]) => money(v!, c as Currency)).join(' + ')} en {commitments.length} pago(s)
              {nextCommitment ? ` · próximo: ${nextCommitment.name} el ${nextCommitment.dueDate.slice(8, 10)}/${nextCommitment.dueDate.slice(5, 7)}` : ''}</small>
          </div>
          <Link href="/app/compromisos" className="section-link">Ver<Icon name="chevron" size={16} /></Link>
        </section>
      )}

      {categories.length > 0 && (
        <section className="card" aria-label="En qué se fue tu dinero">
          <div className="row"><h2>En qué se fue tu dinero</h2><Link href={`/app/analisis?month=${month}`} className="section-link">Análisis<Icon name="chevron" size={16} /></Link></div>
          <ul className="plain stack-sm" style={{ gap: 14, marginTop: 12 }}>
            {categories.slice(0, 6).map(([cat, v]) => (
              <li key={cat} className="cat-row">
                <span>{cat}</span><span className="amount">{money(v, 'PEN')}</span>
                <span className="progress" aria-hidden="true"><span className="fill" style={{ width: `${Math.max(2, (v / topCategory) * 100)}%` }} /></span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Últimos movimientos">
        <div className="row"><h2>Últimos movimientos</h2><Link href={`/app/movimientos?month=${month}`} className="section-link">Ver todos<Icon name="chevron" size={16} /></Link></div>
        {txs.length === 0 ? <p className="muted">Aún no hay movimientos en {monthLabel(month).toLowerCase()}.</p> : (
          <ul className="tx-list" data-testid="tx-list">
            {txs.slice(0, 8).map((t) => <li key={t.id}><TxRow t={t} when={limaDayLabel(t.occurredAt)} /></li>)}
          </ul>
        )}
        <p className="actions small" style={{ marginTop: 8 }}><a href={`/app/exportar?month=${month}`} className="quiet-link muted">Exportar CSV del mes</a></p>
      </section>
    </main>
  );
}

/** First visit: how movements arrive, what Velsuno checks, and one way to start. No bank credentials, ever. */
function Welcome({ name }: { name: string | null }) {
  return (
    <main className="stack narrow-md" data-testid="welcome">
      <div className="page-head">
        <h1>{name ? `Hola, ${name}. Empecemos por lo esencial` : 'Empecemos por lo esencial'}</h1>
        <p>Velsuno ordena tus movimientos y te dice qué pasa con tu dinero. Nunca te pedirá la clave de tu banco.</p>
      </div>
      {!name && (
        <section className="card stack-sm" aria-label="Tus datos">
          <h2>¿Cómo te llamamos?</h2>
          <ActionForm action={saveProfileAction} label="Perfil">
            <ProfileFields givenNames="" familyNames="" displayName="" />
            <button type="submit" style={{ justifySelf: 'start' }}>Guardar</button>
          </ActionForm>
        </section>
      )}
      <ol className="plain stack-sm" style={{ gap: 12 }}>
        <li className="card stack-sm">
          <h2>Registra un movimiento</h2>
          <p className="muted">Un gasto, un ingreso o un retiro. Tarda unos segundos.</p>
          <Link href="/app/movimientos/nuevo" className="button" style={{ justifySelf: 'start' }}>Registrar movimiento</Link>
        </li>
        <li className="card stack-sm">
          <h2>Pega un mensaje de tu banco</h2>
          <p className="muted">Copia la notificación del BCP (correo o SMS) y la leemos por ti. Siempre la revisas antes de que cuente.</p>
          <Link href="/app/importar" className="button secondary" style={{ justifySelf: 'start' }}>Pegar mensaje</Link>
        </li>
        <li className="card stack-sm">
          <h2>Reenvío automático de correos</h2>
          <p className="muted">Pronto podrás reenviar las notificaciones de tu banco a una dirección privada. Aún no está disponible.</p>
        </li>
      </ol>
      <p className="muted small">Lo que no esté claro irá a <strong>Por revisar</strong>: nada dudoso se confirma solo.</p>
    </main>
  );
}
