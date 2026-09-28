import { ActionForm } from '../../../components/action-form';
import { Icon } from '../../../components/ui/icon';
import { Sheet } from '../../../components/ui/sheet';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { loadBudgets, loadCatalog } from '../../../lib/queries';
import { formatMoney } from '../../../src/domain/money';
import { budgetStatus } from '../../../src/engine/budgets';
import { rowToTransaction, TRANSACTION_SELECT, type TransactionRow } from '../../../src/infrastructure/supabase/transaction-row';
import { limaMonth, limaMonthRange } from '../../../src/web/auth-input';
import { monthLabel } from '../../../src/web/labels';
import { minorToInput } from '../../../src/web/transaction-input';
import { deleteBudgetAction, saveBudgetAction } from '../actions';

export const metadata = { title: 'Presupuestos' };
const STATE_WORD = { ok: 'Vas bien', warning: 'Cerca del límite', exceeded: 'Te pasaste' } as const;

function BudgetFields({ categories, categoryId, amount, currency }: { categories: Array<{ id: string; name: string }>; categoryId?: string; amount?: string; currency?: string }) {
  return (
    <>
      {categoryId ? <input type="hidden" name="categoryId" value={categoryId} /> : (
        <label className="stack-sm"><span>Categoría</span>
          <select name="categoryId" required defaultValue="">
            <option value="" disabled>Elige</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></label>
      )}
      <label className="stack-sm"><span>Límite al mes</span>
        <span className="money-input"><span className="cur" aria-hidden="true">{currency === 'USD' ? 'US$' : 'S/'}</span>
          <input name="amount" required inputMode="decimal" placeholder="500.00" defaultValue={amount} autoComplete="off" /></span></label>
      {categoryId ? <input type="hidden" name="currency" value={currency} /> : (
        <label className="stack-sm"><span>Moneda</span>
          <select name="currency" defaultValue="PEN"><option value="PEN">Soles (S/)</option><option value="USD">Dólares (US$)</option></select></label>
      )}
    </>
  );
}

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
  const categoryId = new Map(catalog.categories.filter((c) => !c.own).map((c) => [c.name, c.id]));
  const spendable = catalog.categories.filter((c) => !c.own).map((c) => ({ id: c.id, name: c.name }));
  const over = status.filter((b) => b.state === 'exceeded');
  const headline = status.length === 0 ? null
    : over.length ? `Te pasaste en ${over.map((b) => b.category).join(' y ')}.`
    : status.some((b) => b.state === 'warning') ? 'Vas bien, pero algo está cerca del límite.' : 'Vas bien en todos tus presupuestos.';

  const create = (
    <Sheet label={<><Icon name="add" size={18} />Nuevo presupuesto</>} triggerClassName={status.length ? 'quiet' : ''} title="Nuevo presupuesto" testId="budget-sheet">
      <div className="sheet-body">
        <ActionForm action={saveBudgetAction} label="Guardar presupuesto" closeOnSuccess>
          <BudgetFields categories={spendable} />
          <button type="submit" className="wide">Guardar</button>
        </ActionForm>
      </div>
    </Sheet>
  );

  return (
    <main className="stack narrow-md">
      <div className="page-head">
        <h1>Presupuestos</h1>
        <p>{headline ?? monthLabel(month)}</p>
      </div>

      {status.length === 0 ? (
        <section className="stack-sm">
          <p>Aún no hay presupuestos. Crea uno si quieres seguir un límite mensual en alguna categoría.</p>
          <div>{create}</div>
        </section>
      ) : (
        <>
          <ul className="plain budget-list" data-testid="budget-list">
            {status.map((b) => {
              const m = (v: number) => formatMoney({ amountMinor: Math.abs(v), currency: b.currency });
              return (
                <li key={`${b.category}|${b.currency}`} className="budget" data-state={b.state}>
                  <div className="row" style={{ alignItems: 'baseline' }}>
                    <strong>{b.category}</strong>
                    <span className={`state-word ${b.state}`}>{STATE_WORD[b.state]}</span>
                  </div>
                  <span className="progress" aria-hidden="true"><span className={`fill ${b.state}`} style={{ width: `${Math.min(100, b.ratio * 100)}%` }} /></span>
                  <div className="row small">
                    <span className="amount">{m(b.spentMinor)} de {m(b.amountMinor)}</span>
                    <span className={b.state === 'exceeded' ? 'error' : 'muted'}>{b.state === 'exceeded' ? `Te pasaste por ${m(b.remainingMinor)}` : `Te quedan ${m(b.remainingMinor)}`}</span>
                  </div>
                  <Sheet label="Cambiar" triggerClassName="link small-link" title={`Presupuesto de ${b.category}`} triggerLabel={`Cambiar presupuesto de ${b.category}`}>
                    <div className="sheet-body stack">
                      <ActionForm action={saveBudgetAction} label={`Cambiar presupuesto ${b.category}`} closeOnSuccess>
                        <BudgetFields categories={spendable} categoryId={categoryId.get(b.category)} amount={minorToInput(b.amountMinor)} currency={b.currency} />
                        <button type="submit" className="wide">Guardar</button>
                      </ActionForm>
                      <ActionForm action={deleteBudgetAction} className="inline" label={`Eliminar presupuesto ${b.category}`} closeOnSuccess>
                        <input type="hidden" name="id" value={idOf.get(`${b.category}|${b.currency}`) ?? ''} />
                        <button type="submit" className="link" style={{ color: 'var(--semantic-error)' }}>Quitar este presupuesto</button>
                      </ActionForm>
                    </div>
                  </Sheet>
                </li>
              );
            })}
          </ul>
          <div>{create}</div>
        </>
      )}
      <p className="muted small">Cuenta lo confirmado de {monthLabel(month).toLowerCase()}. Las devoluciones lo reducen; los pagos de tarjeta, las transferencias entre tus cuentas y los retiros no son gasto.</p>
    </main>
  );
}
