import { formatMoney, type Currency } from '../src/domain/money';
import type { MonthlySummary } from '../src/engine/monthly-summary';
import { MONTHS_SHORT } from '../src/domain/dates';

/**
 * Income vs spending per month, compact columns (oldest first). Only confirmed movements (monthlySummary); a month
 * without data shows empty columns, never an invented value. One currency per chart: PEN and USD never mixed.
 */
export function TrendBars({ months, currency, testId }: { months: readonly MonthlySummary[]; currency: Currency; testId?: string }) {
  const max = Math.max(1, ...months.map((m) => Math.max(m.incomeMinor, m.expensesMinor)));
  const money = (v: number) => formatMoney({ amountMinor: v, currency });
  return (
    <figure className="trend" data-testid={testId}>
      <ul className="plain trend-cols" aria-label="Ingresos y gastos por mes">
        {months.map((m) => {
          const label = MONTHS_SHORT[Number(m.month.slice(5, 7)) - 1]!;
          return (
            <li key={m.month} aria-label={`${label}: ingresos ${money(m.incomeMinor)}, gastos ${money(m.expensesMinor)}`}>
              <span className="trend-pair" aria-hidden="true">
                <span className="col income" style={{ height: `${(m.incomeMinor / max) * 100}%` }} />
                <span className="col expense" style={{ height: `${(Math.max(0, m.expensesMinor) / max) * 100}%` }} />
              </span>
              <span className="trend-label" aria-hidden="true">{label}</span>
            </li>
          );
        })}
      </ul>
      <figcaption className="trend-legend small"><span><i className="income" />Ingresos</span><span><i className="expense" />Gastos</span></figcaption>
    </figure>
  );
}
