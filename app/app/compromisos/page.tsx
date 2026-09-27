import { ActionForm } from '../../../components/action-form';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { loadCatalog, loadCommitmentData } from '../../../lib/queries';
import { formatMoney } from '../../../src/domain/money';
import { debtProgress, monthCommitments, totalsByCurrency } from '../../../src/engine/commitments';
import { limaMonth } from '../../../src/web/auth-input';
import { formatLimaDateTime } from '../../../src/web/transaction-input';
import { deactivateCommitmentAction, debtPaymentAction, saveDebtAction, saveFixedExpenseAction } from '../actions';

const CUR = <><option value="PEN">Soles (S/)</option><option value="USD">Dólares (US$)</option></>;

export default async function Commitments() {
  const supabase = await createSupabaseServerClient();
  const [{ fixed, debts }, catalog] = await Promise.all([loadCommitmentData(supabase), loadCatalog(supabase)]);
  const month = limaMonth();
  const today = formatLimaDateTime(new Date().toISOString()).slice(0, 10).split('/').reverse().join('-');
  const items = monthCommitments(month, today, fixed, debts);
  const totals = totalsByCurrency(items);
  return (
    <main className="stack narrow-md">
      <h1>Compromisos</h1>
      <p className="muted">Gastos fijos y cuotas de deudas del mes. Son recordatorios: no cuentan como gasto por sí solos, porque el pago real
        llega (o lo registras) como movimiento.</p>

      <section className="card stack-sm">
        <h2>Este mes ({month})</h2>
        {items.length === 0 ? <p className="muted">Sin compromisos registrados.</p> : (
          <>
            <ul className="list" data-testid="commitment-list">
              {items.map((c) => (
                <li key={`${c.kind}-${c.id}`}>
                  <span>{c.name}<br /><small className="muted">{c.kind === 'debt' ? 'Cuota' : 'Gasto fijo'} · vence {c.dueDate.slice(8, 10)}/{c.dueDate.slice(5, 7)}
                    {c.daysUntil < 0 ? ' · ya pasó la fecha' : c.daysUntil <= 3 ? ` · en ${c.daysUntil} día(s)` : ''}</small></span>
                  <span className="amount">{formatMoney(c)}</span>
                </li>
              ))}
            </ul>
            <p data-testid="commitment-total"><strong>Total del mes:</strong> {Object.entries(totals).map(([cur, v]) => formatMoney({ amountMinor: v!, currency: cur as 'PEN' | 'USD' })).join(' + ')}</p>
          </>
        )}
      </section>

      <section className="card stack-sm">
        <h2>Gastos fijos</h2>
        <ul className="list">
          {fixed.filter((f) => f.active).map((f) => (
            <li key={f.id}><span>{f.name} <small className="muted">día {f.dueDay}</small></span>
              <span className="actions"><span className="amount">{formatMoney(f)}</span>
                <ActionForm action={deactivateCommitmentAction} className="inline" label={`Quitar ${f.name}`}>
                  <input type="hidden" name="id" value={f.id} /><input type="hidden" name="kind" value="fixed" />
                  <button type="submit" className="link">Quitar</button>
                </ActionForm></span></li>
          ))}
        </ul>
        <details><summary>Agregar gasto fijo</summary>
          <ActionForm action={saveFixedExpenseAction} label="Agregar gasto fijo">
            <div className="grid">
              <label className="stack-sm"><span>Nombre</span><input name="name" required maxLength={60} placeholder="Alquiler" /></label>
              <label className="stack-sm"><span>Monto</span><input name="amount" required inputMode="decimal" /></label>
              <label className="stack-sm"><span>Moneda</span><select name="currency" defaultValue="PEN">{CUR}</select></label>
              <label className="stack-sm"><span>Día de pago</span><input name="dueDay" required inputMode="numeric" pattern="\d{1,2}" /></label>
              <label className="stack-sm"><span>Categoría</span><select name="categoryId" defaultValue="">
                <option value="">—</option>{catalog.categories.filter((c) => !c.own).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            </div>
            <button type="submit">Agregar</button>
          </ActionForm>
        </details>
      </section>

      <section className="card stack-sm">
        <h2>Deudas</h2>
        <ul className="plain stack">
          {debts.filter((d) => d.active).map((d) => {
            const p = debtProgress(d);
            const m = (v: number) => formatMoney({ amountMinor: v, currency: d.currency });
            return (
              <li key={d.id} className="stack-sm" data-testid="debt">
                <div className="row"><strong>{d.name}{d.lender ? ` · ${d.lender}` : ''}</strong><span className="amount">Saldo {m(d.balanceMinor)}</span></div>
                <span className="progress"><span className="fill" style={{ width: `${p.ratio * 100}%` }} /></span>
                <small className="muted">Pagado {m(p.paidMinor)} de {m(d.principalMinor)}
                  {d.installmentsTotal ? ` · cuota ${d.installmentsPaid}/${d.installmentsTotal}` : ''}{d.annualRateBp !== null ? ` · tasa ${(d.annualRateBp / 100).toFixed(2)}%` : ''}</small>
                {d.balanceMinor > 0 && (
                  <ActionForm action={debtPaymentAction} className="inline" label={`Pago ${d.name}`}>
                    <input type="hidden" name="id" value={d.id} />
                    <span className="actions"><input name="amount" required inputMode="decimal" placeholder={d.installmentMinor ? (d.installmentMinor / 100).toFixed(2) : 'Monto'} style={{ maxWidth: 140 }} />
                      <button type="submit" className="secondary">Registrar pago</button></span>
                  </ActionForm>
                )}
              </li>
            );
          })}
        </ul>
        <details><summary>Agregar deuda</summary>
          <ActionForm action={saveDebtAction} label="Agregar deuda">
            <div className="grid">
              <label className="stack-sm"><span>Nombre</span><input name="name" required maxLength={60} placeholder="Préstamo auto" /></label>
              <label className="stack-sm"><span>Entidad</span><input name="lender" maxLength={60} placeholder="BCP" /></label>
              <label className="stack-sm"><span>Moneda</span><select name="currency" defaultValue="PEN">{CUR}</select></label>
              <label className="stack-sm"><span>Monto original</span><input name="principal" required inputMode="decimal" /></label>
              <label className="stack-sm"><span>Saldo actual</span><input name="balance" inputMode="decimal" placeholder="= monto original" /></label>
              <label className="stack-sm"><span>Tasa anual %</span><input name="rate" inputMode="decimal" /></label>
              <label className="stack-sm"><span>Cuota</span><input name="installment" inputMode="decimal" /></label>
              <label className="stack-sm"><span>N.º de cuotas</span><input name="installmentsTotal" inputMode="numeric" /></label>
              <label className="stack-sm"><span>Cuotas pagadas</span><input name="installmentsPaid" inputMode="numeric" /></label>
              <label className="stack-sm"><span>Día de pago</span><input name="dueDay" inputMode="numeric" /></label>
            </div>
            <button type="submit">Agregar deuda</button>
          </ActionForm>
        </details>
      </section>
    </main>
  );
}
