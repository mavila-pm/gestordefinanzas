import Link from 'next/link';
import { createSupabaseServerClient } from '../../lib/supabase/server';
import { formatMoney, type Currency } from '../../src/domain/money';
import { monthlySummary } from '../../src/engine/monthly-summary';
import { rowToTransaction, TRANSACTION_SELECT, type TransactionRow } from '../../src/infrastructure/supabase/transaction-row';
import { limaMonth, limaMonthRange } from '../../src/web/auth-input';
import { TYPE_LABEL } from '../../src/web/transaction-input';

const CURRENCIES: Currency[] = ['PEN', 'USD'];
const SOURCE_LABEL: Record<string, string> = { email: 'Automático · Email', sms: 'Automático · SMS', manual: 'Manual' };

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ month?: string; deleted?: string }> }) {
  const { month: requested, deleted } = await searchParams;
  const month = requested && limaMonthRange(requested) ? requested : limaMonth();
  const range = limaMonthRange(month)!;

  const supabase = await createSupabaseServerClient();
  // RLS scopes this to the signed-in user; no user_id filter can widen it.
  const { data, error } = await supabase
    .from('transactions')
    .select(TRANSACTION_SELECT)
    .gte('occurred_at', range.from)
    .lt('occurred_at', range.to)
    .order('occurred_at', { ascending: false })
    .limit(500);

  if (error) {
    return <main className="stack"><p role="alert" className="error">No se pudieron cargar tus movimientos.</p></main>;
  }
  const txs = (data as unknown as TransactionRow[]).map(rowToTransaction);
  const summaries = CURRENCIES.map((c) => monthlySummary(txs, month, c)).filter((s, i) => i === 0 || txs.some((t) => t.currency === s.currency));

  return (
    <main className="stack">
      {deleted === '1' && <p role="status" className="ok">Movimiento eliminado.</p>}
      <h1>Resumen de {month}</h1>
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
