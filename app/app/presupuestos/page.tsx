import { ActionForm } from '../../../components/action-form';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { loadBudgets, loadCatalog } from '../../../lib/queries';
import { formatMoney } from '../../../src/domain/money';
import { budgetStatus } from '../../../src/engine/budgets';
import { rowToTransaction, TRANSACTION_SELECT, type TransactionRow } from '../../../src/infrastructure/supabase/transaction-row';
import { limaMonth, limaMonthRange } from '../../../src/web/auth-input';
import { minorToInput } from '../../../src/web/transaction-input';
import { deleteBudgetAction, saveBudgetAction } from '../actions';

export default async function Budgets() {
  const supabase = await createSupabaseServerClient();
  const month = limaMonth();
  const range = limaMonthRange(month)!;
  const [budgets, catalog, txRes] = await Promise.all([
    loadBudgets(supabase), loadCatalog(supabase),
    supabase.from('transactions').select(TRANSACTION_SELECT).gte('occurred_at', range.from).lt('occurred_at', range.to).limit(3000),
  ]);
  const txs = ((txRes.data ?? []) as unknown as TransactionRow[]).map(rowToTransaction);
  const status = budgetStatus(txs, month, budgets);
  const idOf = new Map(budgets.map((b) => [`${b.category}|${b.currency}`, b.id]));
  const spendable = catalog.categories.filter((c) => !c.own);
  return (
    <main className="stack narrow-md">
      <h1>Presupuestos de {month}</h1>
      <p className="muted">Límite mensual por categoría. Cuenta solo lo confirmado; las devoluciones lo reducen. Pagos de tarjeta,
        transferencias propias y retiros de efectivo no son gasto.</p>
      <section className="card stack-sm">
        {status.length === 0 ? <p className="muted">Aún no tienes presupuestos.</p> : (
          <ul className="plain stack-sm" data-testid="budget-list">
            {status.map((b) => {
              const m = (v: number) => formatMoney({ amountMinor: Math.abs(v), currency: b.currency });
              return (
                <li key={`${b.category}|${b.currency}`} className="stack-sm" data-state={b.state}>
                  <div className="row"><strong>{b.category}</strong><span className="amount">{m(b.spentMinor)} / {m(b.amountMinor)}</span></div>
                  <span className="progress"><span className={`fill ${b.state}`} style={{ width: `${Math.min(100, b.ratio * 100)}%` }} /></span>
                  <div className="row small">
                    <span className={b.state === 'exceeded' ? 'error' : b.state === 'warning' ? 'warn' : 'muted'}>
                      {b.state === 'exceeded' ? `Excedido por ${m(b.remainingMinor)}` : `Quedan ${m(b.remainingMinor)}`}
                    </span>
                    <ActionForm action={deleteBudgetAction} className="inline" label={`Eliminar presupuesto ${b.category}`}>
                      <input type="hidden" name="id" value={idOf.get(`${b.category}|${b.currency}`) ?? ''} />
                      <button type="submit" className="link">Eliminar</button>
                    </ActionForm>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section className="card">
        <ActionForm action={saveBudgetAction} label="Guardar presupuesto">
          <div className="grid">
            <label className="stack-sm"><span>Categoría</span>
              <select name="categoryId" required defaultValue="">
                <option value="" disabled>Elige</option>
                {spendable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></label>
            <label className="stack-sm"><span>Límite mensual</span><input name="amount" required inputMode="decimal" placeholder="500.00"
              defaultValue={status[0] ? '' : minorToInput(50000)} /></label>
            <label className="stack-sm"><span>Moneda</span>
              <select name="currency" defaultValue="PEN"><option value="PEN">Soles (S/)</option><option value="USD">Dólares (US$)</option></select></label>
          </div>
          <button type="submit">Guardar presupuesto</button>
        </ActionForm>
      </section>
    </main>
  );
}
