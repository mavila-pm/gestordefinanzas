import Link from 'next/link';
import { createSupabaseServerClient } from '../../lib/supabase/server';
import { formatMoney, type Currency } from '../../src/domain/money';
import { monthlySummary } from '../../src/engine/monthly-summary';
import { previousMonth } from '../../src/engine/analysis';
import { buildAlerts } from '../../src/engine/alerts';
import { dataHealth } from '../../src/engine/data-health';
import { closedMonthMilestone, mainInsight } from '../../src/engine/insights';
import { budgetStatus } from '../../src/engine/budgets';
import { loadBudgets } from '../../lib/queries';
import { rowToTransaction, TRANSACTION_SELECT, type TransactionRow } from '../../src/infrastructure/supabase/transaction-row';
import { limaMonth, limaMonthRange } from '../../src/web/auth-input';
import { TYPE_LABEL } from '../../src/web/transaction-input';

const CURRENCIES: Currency[] = ['PEN', 'USD'];
const SOURCE_LABEL: Record<string, string> = { email: 'Automático · Email', sms: 'Automático · SMS', import: 'Importado por ti', manual: 'Manual' };

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
  const [txRes, pendingRes, oldestRes, unresolvedRes, autoRes, profileRes, budgets] = await Promise.all([
    supabase.from('transactions').select(TRANSACTION_SELECT).gte('occurred_at', windowFrom).lt('occurred_at', range.to)
      .order('occurred_at', { ascending: false }).limit(3000),
    supabase.from('transactions').select('id', { count: 'exact', head: true }).in('status', ['review_required', 'possible_duplicate']),
    supabase.from('transactions').select('created_at').in('status', ['review_required', 'possible_duplicate']).order('created_at').limit(1),
    supabase.from('financial_events').select('id', { count: 'exact', head: true }).eq('outcome', 'unresolved').gte('created_at', since30),
    supabase.from('transaction_sources').select('id', { count: 'exact', head: true }).in('channel', ['email', 'sms']).gte('received_at', since30),
    supabase.from('profiles').select('display_name').maybeSingle(),
    loadBudgets(supabase),
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
  const alerts = buildAlerts({ txs: all, pendingCount, oldestPendingDays, unresolvedEvents30d, now, currency: 'PEN', budgets: month === currentMonth ? budgetsNow : [] });
  const insight = mainInsight(all, month, 'PEN');
  // Milestones are event-driven: only the month that just closed, shown while viewing the current month.
  const firstName = (profileRes.data?.display_name as string | null | undefined)?.split(' ')[0] ?? null;
  const milestone = month === currentMonth
    ? closedMonthMilestone(all, previousMonth(currentMonth), 'PEN', { firstName, dataHealthOk: health.level !== 'ACTION_REQUIRED', budgets })
    : null;
  const HEALTH_LABEL = { HEALTHY: 'Datos al día', PARTIAL: 'Datos parciales', ACTION_REQUIRED: 'Requiere tu acción' } as const;

  return (
    <main className="stack">
      {deleted === '1' && <p role="status" className="ok">Movimiento eliminado.</p>}
      <div className="row">
        <h1>Resumen de {month}</h1>
        <span className="actions">
          <Link href={`/app?month=${previousMonth(month)}`}>← Anterior</Link>
          {month < limaMonth() && <Link href={`/app?month=${previousMonth(month, -1)}`}>Siguiente →</Link>}
        </span>
      </div>
      {milestone && <section className="card milestone" data-testid="milestone" aria-label="Cierre de mes"><p>{milestone.text}</p></section>}
      <section className={`card health ${health.level.toLowerCase()}`} data-testid="data-health" aria-label="Estado de tus datos">
        <strong>{HEALTH_LABEL[health.level]}</strong>
        {health.reasons.length > 0 && <ul className="small">{health.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
      </section>
      {alerts.length > 0 && (
        <ul className="stack-sm plain" data-testid="alerts" aria-label="Alertas">
          {alerts.map((a) => (
            <li key={a.code} className={`alert ${a.level.toLowerCase()}`} data-alert={a.code}>
              {a.href ? <Link href={a.href}>{a.text}</Link> : a.text}
            </li>
          ))}
        </ul>
      )}
      {insight && <p className="card insight" data-testid="insight">{insight.estimated ? 'Estimado: ' : ''}{insight.text}</p>}
      <p className="actions small"><Link href={`/app/analisis?month=${month}`}>Ver análisis</Link><Link href={`/app/movimientos?month=${month}`}>Ver todos los movimientos</Link><a href={`/app/exportar?month=${month}`}>Exportar CSV</a></p>
      {summaries.map((s) => {
        const m = (v: number) => formatMoney({ amountMinor: Math.abs(v), currency: s.currency });
        return (
          <section key={s.currency} className="card stack" aria-label={`Resumen ${s.currency}`}>
            <div className="grid">
              <div><span className="muted">Ingresos</span><p className="big" data-testid={`income-${s.currency}`}>{m(s.incomeMinor)}</p></div>
              <div><span className="muted">Gastos</span><p className="big" data-testid={`expenses-${s.currency}`}>{m(s.expensesMinor)}</p></div>
              <div>
                <span className="muted">{s.savingsLabel === 'confirmed' ? 'Ahorro confirmado' : 'Ahorro estimado'}</span>
                <p className="big" data-testid={`net-${s.currency}`}>{s.netCashFlowMinor < 0 ? '−' : ''}{m(s.netCashFlowMinor)}</p>
              </div>
            </div>
            {s.cashWithdrawalsMinor > 0 && <p className="muted">Retiros de efectivo (no cuentan como gasto): {m(s.cashWithdrawalsMinor)}</p>}
            {s.pendingCount > 0 && <p className="warn">{s.pendingCount} movimiento(s) por revisar. Las cifras son estimadas hasta que los confirmes. <Link href="/app/revisar">Revisar ahora</Link></p>}
            {Object.keys(s.expensesByCategory).length > 0 && (
              <ul className="list">
                {Object.entries(s.expensesByCategory).sort((a, b) => b[1] - a[1]).map(([cat, v]) => (
                  <li key={cat}><span>{cat}</span><span>{m(v)}</span></li>
                ))}
              </ul>
            )}
          </section>
        );
      })}

      <section className="card stack">
        <h2>Movimientos</h2>
        {txs.length === 0 ? <p className="muted">Aún no hay movimientos este mes.</p> : (
          <ul className="list" data-testid="tx-list">
            {txs.slice(0, 50).map((t) => (
              <li key={t.id}>
                <span>
                  <Link href={`/app/movimientos/${t.id}`}><strong>{t.merchantRaw ?? TYPE_LABEL[t.type]}</strong></Link><br />
                  <small className="muted">
                    {[t.category, t.institution && t.cardLast4 ? `${t.institution} ****${t.cardLast4}` : t.institution, SOURCE_LABEL[t.sources[0]?.channel ?? 'manual'], t.status === 'ignored' ? 'Ignorado' : t.status !== 'confirmed' ? 'Por revisar' : null].filter(Boolean).join(' · ')}
                  </small>
                </span>
                <span>{t.direction === 'inflow' ? '+' : t.direction === 'outflow' ? '−' : ''}{formatMoney(t)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
