import { ActionForm } from '../../../components/action-form';
import { Icon } from '../../../components/ui/icon';
import { Sheet } from '../../../components/ui/sheet';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { loadCatalog, loadCommitmentData, loadEntitlements, loadRecurring } from '../../../lib/queries';
import { formatMoney } from '../../../src/domain/money';
import { debtProgress, monthCommitments, totalsByCurrency } from '../../../src/engine/commitments';
import { limaMonth } from '../../../src/web/auth-input';
import { monthLabel } from '../../../src/web/labels';
import { formatLimaDateTime } from '../../../src/web/transaction-input';
import { deactivateCommitmentAction, debtPaymentAction, saveDebtAction, saveFixedExpenseAction } from '../actions';

export const metadata = { title: 'Próximos pagos' };
const CUR = <><option value="PEN">Soles (S/)</option><option value="USD">Dólares (US$)</option></>;

export default async function Commitments() {
  const supabase = await createSupabaseServerClient();
  const [{ fixed, debts }, catalog, { entitlements }] = await Promise.all([loadCommitmentData(supabase), loadCatalog(supabase), loadEntitlements(supabase)]);
  const month = limaMonth();
  // Plus feature: decided and computed on the server only (§84).
  const recurring = entitlements.features.recurringDetection ? await loadRecurring(supabase, month, fixed) : null;
  const today = formatLimaDateTime(new Date().toISOString()).slice(0, 10).split('/').reverse().join('-');
  const items = monthCommitments(month, today, fixed, debts);
  const totals = totalsByCurrency(items);
  const activeFixed = fixed.filter((f) => f.active);
  const activeDebts = debts.filter((d) => d.active);
  const total = Object.entries(totals).map(([cur, v]) => formatMoney({ amountMinor: v!, currency: cur as 'PEN' | 'USD' })).join(' + ');

  return (
    <main className="stack narrow-md">
      <div className="page-head">
        <h1>Próximos pagos</h1>
        <p>{items.length ? <>{monthLabel(month)} · <span data-testid="commitment-total">Total del mes: {total}</span></> : 'Anota tus pagos fijos y deudas para verlos venir.'}</p>
      </div>

      {items.length > 0 && (
        <ul className="list card" data-testid="commitment-list" style={{ paddingTop: 4, paddingBottom: 4 }}>
          {items.map((c) => (
            <li key={`${c.kind}-${c.id}`}>
              <span className="setting-text">
                <span>{c.name}</span>
                <small className={c.daysUntil < 0 ? 'muted' : c.daysUntil <= 3 ? 'warn' : 'muted'}>
                  {c.daysUntil < 0 ? `Venció el ${c.dueDate.slice(8, 10)}/${c.dueDate.slice(5, 7)}` : c.daysUntil === 0 ? 'Vence hoy' : c.daysUntil <= 3 ? `Vence en ${c.daysUntil} día(s)` : `Vence el ${c.dueDate.slice(8, 10)}/${c.dueDate.slice(5, 7)}`}
                  {' · '}{c.kind === 'debt' ? 'Cuota' : 'Gasto fijo'}
                </small>
              </span>
              <span className="amount">{formatMoney(c)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="actions">
        <Sheet label={<><Icon name="add" size={18} />Agregar gasto fijo</>} triggerClassName="quiet" title="Gasto fijo" subtitle="Algo que pagas cada mes: alquiler, colegio, internet." testId="fixed-sheet">
          <div className="sheet-body">
            <ActionForm action={saveFixedExpenseAction} label="Agregar gasto fijo" closeOnSuccess>
              <label className="stack-sm"><span>Nombre</span><input name="name" required maxLength={60} placeholder="Alquiler" /></label>
              <div className="grid">
                <label className="stack-sm"><span>Monto</span><input name="amount" required inputMode="decimal" autoComplete="off" /></label>
                <label className="stack-sm"><span>Moneda</span><select name="currency" defaultValue="PEN">{CUR}</select></label>
                <label className="stack-sm"><span>Día de pago</span><input name="dueDay" required inputMode="numeric" pattern="\d{1,2}" placeholder="1–31" /></label>
              </div>
              <label className="stack-sm"><span>Categoría (opcional)</span><select name="categoryId" defaultValue="">
                <option value="">—</option>{catalog.categories.filter((c) => !c.own).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
              <button type="submit" className="wide">Agregar</button>
            </ActionForm>
          </div>
        </Sheet>
        <Sheet label={<><Icon name="add" size={18} />Agregar deuda</>} triggerClassName="quiet" title="Deuda" subtitle="Un préstamo o compra en cuotas." testId="debt-sheet">
          <div className="sheet-body">
            <ActionForm action={saveDebtAction} label="Agregar deuda" closeOnSuccess>
              <div className="grid">
                <label className="stack-sm"><span>Nombre</span><input name="name" required maxLength={60} placeholder="Préstamo auto" /></label>
                <label className="stack-sm"><span>Entidad</span><input name="lender" maxLength={60} placeholder="BCP" /></label>
              </div>
              <div className="grid">
                <label className="stack-sm"><span>Monto original</span><input name="principal" required inputMode="decimal" autoComplete="off" /></label>
                <label className="stack-sm"><span>Saldo actual</span><input name="balance" inputMode="decimal" placeholder="Igual al original" autoComplete="off" /></label>
                <label className="stack-sm"><span>Moneda</span><select name="currency" defaultValue="PEN">{CUR}</select></label>
              </div>
              <div className="grid">
                <label className="stack-sm"><span>Cuota</span><input name="installment" inputMode="decimal" autoComplete="off" /></label>
                <label className="stack-sm"><span>Día de pago</span><input name="dueDay" inputMode="numeric" placeholder="1–31" /></label>
              </div>
              <details>
                <summary>Cuotas y tasa (opcional)</summary>
                <div className="grid" style={{ paddingTop: 8 }}>
                  <label className="stack-sm"><span>N.º de cuotas</span><input name="installmentsTotal" inputMode="numeric" /></label>
                  <label className="stack-sm"><span>Cuotas pagadas</span><input name="installmentsPaid" inputMode="numeric" /></label>
                  <label className="stack-sm"><span>Tasa anual %</span><input name="rate" inputMode="decimal" /></label>
                </div>
              </details>
              <button type="submit" className="wide">Agregar deuda</button>
            </ActionForm>
          </div>
        </Sheet>
      </div>

      {activeDebts.length > 0 && (
        <section aria-labelledby="h-debts" className="stack-sm">
          <h2 id="h-debts">Deudas</h2>
          <ul className="plain budget-list">
            {activeDebts.map((d) => {
              const p = debtProgress(d);
              const m = (v: number) => formatMoney({ amountMinor: v, currency: d.currency });
              return (
                <li key={d.id} className="budget" data-testid="debt">
                  <div className="row" style={{ alignItems: 'baseline' }}><strong>{d.name}{d.lender ? ` · ${d.lender}` : ''}</strong><span className="amount">Saldo {m(d.balanceMinor)}</span></div>
                  <span className="progress" aria-hidden="true"><span className="fill" style={{ width: `${p.ratio * 100}%` }} /></span>
                  <small className="muted">Pagado {m(p.paidMinor)} de {m(d.principalMinor)}
                    {d.installmentsTotal ? ` · cuota ${d.installmentsPaid}/${d.installmentsTotal}` : ''}{d.annualRateBp !== null ? ` · tasa ${(d.annualRateBp / 100).toFixed(2)}%` : ''}</small>
                  <div className="actions">
                    {d.balanceMinor > 0 && (
                      <Sheet label="Registrar pago" triggerClassName="link small-link" title={`Pago de ${d.name}`} triggerLabel={`Registrar pago de ${d.name}`}
                        subtitle={<>Saldo {m(d.balanceMinor)}</>}>
                        <div className="sheet-body">
                          <ActionForm action={debtPaymentAction} label={`Pago ${d.name}`} closeOnSuccess>
                            <input type="hidden" name="id" value={d.id} />
                            <label className="stack-sm"><span>Monto pagado</span>
                              <input name="amount" required inputMode="decimal" autoComplete="off" defaultValue={d.installmentMinor ? (d.installmentMinor / 100).toFixed(2) : ''} /></label>
                            <small className="muted">Solo baja el saldo de la deuda. No crea un gasto: el pago ya aparece en tus movimientos cuando llega del banco.</small>
                            <button type="submit" className="wide">Registrar pago</button>
                          </ActionForm>
                        </div>
                      </Sheet>
                    )}
                    <ActionForm action={deactivateCommitmentAction} className="inline" label={`Quitar ${d.name}`}>
                      <input type="hidden" name="id" value={d.id} /><input type="hidden" name="kind" value="debt" />
                      <button type="submit" className="link small-link muted-link">Quitar</button>
                    </ActionForm>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {activeFixed.length > 0 && (
        <section aria-labelledby="h-fixed" className="stack-sm">
          <h2 id="h-fixed">Gastos fijos</h2>
          <ul className="list card" style={{ paddingTop: 4, paddingBottom: 4 }}>
            {activeFixed.map((f) => (
              <li key={f.id}>
                <span className="setting-text"><span>{f.name}</span><small className="muted">Cada mes, el día {f.dueDay}</small></span>
                <span className="actions"><span className="amount">{formatMoney(f)}</span>
                  <ActionForm action={deactivateCommitmentAction} className="inline" label={`Quitar ${f.name}`}>
                    <input type="hidden" name="id" value={f.id} /><input type="hidden" name="kind" value="fixed" />
                    <button type="submit" className="icon" aria-label={`Quitar ${f.name}`}><Icon name="close" size={18} /></button>
                  </ActionForm></span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="stack-sm" data-testid="recurring" aria-labelledby="h-rec">
        <h2 id="h-rec">Cobros que se repiten</h2>
        {!entitlements.features.recurringDetection ? (
          <p className="muted">Disponible en Plus: detectamos cobros que se repiten cada mes para que no se te pase ninguno.</p>
        ) : recurring === null ? <p role="alert" className="error">No pudimos revisar tus movimientos. Intenta de nuevo.</p>
          : recurring.length === 0 ? <p className="muted">Aún no vemos cobros que se repitan al menos 3 meses con monto y fecha parecidos.</p> : (
          <ul className="list card" data-testid="recurring-list" style={{ paddingTop: 4, paddingBottom: 4 }}>
            {recurring.map((r) => (
              <li key={`${r.currency}-${r.merchant}`}>
                <span className="setting-text"><span>{r.merchant}</span><small className="muted">alrededor del día {r.dayOfMonth} · {r.months.length} meses</small></span>
                <span className="actions"><span className="amount">{formatMoney({ amountMinor: r.typicalAmountMinor, currency: r.currency })}</span>
                  {r.tracked ? <small className="muted">Ya es gasto fijo</small> : (
                    <ActionForm action={saveFixedExpenseAction} className="inline" label={`Agregar ${r.merchant} como gasto fijo`}>
                      <input type="hidden" name="name" value={r.merchant.slice(0, 60)} />
                      <input type="hidden" name="amount" value={(r.typicalAmountMinor / 100).toFixed(2)} />
                      <input type="hidden" name="currency" value={r.currency} />
                      <input type="hidden" name="dueDay" value={String(Math.min(r.dayOfMonth, 28))} />
                      <button type="submit" className="link small-link">Agregar como gasto fijo</button>
                    </ActionForm>)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="muted small">Son recordatorios: no cuentan como gasto. El pago real llega (o lo registras) como movimiento.</p>
    </main>
  );
}
