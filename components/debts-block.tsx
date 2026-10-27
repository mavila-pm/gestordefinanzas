import { ActionForm } from './action-form';
import { Icon } from './ui/icon';
import { Sheet } from './ui/sheet';
import type { PlanningData } from '../lib/planning';
import type { loadCommitmentData } from '../lib/queries';
import { formatMoney } from '../src/domain/money';
import { debtInstallmentDue, debtProgress } from '../src/engine/commitments';
import type { compareDebtStrategies } from '../src/engine/planning';
import type { comparePayoff } from '../src/engine/scenarios';
import { deactivateCommitmentAction, debtPaymentAction, saveDebtAction } from '../app/app/actions';

const CUR = <><option value="PEN">Soles (S/)</option><option value="USD">Dólares (US$)</option></>;
type Debt = Awaited<ReturnType<typeof loadCommitmentData>>['debts'][number];

/**
 * Debts with people and institutions (ADR-0017 §D): balance, progress, "Registrar pago" (abonos add up to the
 * installment), which one to pay first (avalanche / snowball, simulation only) and "Agregar deuda". Shared by Deudas
 * and Próximos pagos (an installment is also a payment that comes).
 */
export function DebtsBlock({ debts: activeDebts, plan, month, strategies, payoff, cuota }: {
  debts: Debt[]; plan: PlanningData; month: string; strategies: ReturnType<typeof compareDebtStrategies>;
  payoff: ReturnType<typeof comparePayoff> | null; cuota: string | null;
}) {
  return (
    <>
      {activeDebts.length > 0 && (
        <section aria-labelledby="h-debts" className="stack-sm">
          <h3 id="h-debts" className="sub-title">Deudas</h3>
          <ul className="plain budget-list">
            {activeDebts.map((d) => {
              const p = debtProgress(d);
              const m = (v: number) => formatMoney({ amountMinor: v, currency: d.currency });
              // What is left of this month's installment after its abonos (prefilled; the person can type any amount).
              const monthPaid = plan.settledObligations.get(d.id)?.has(month) ? 0 : plan.partialPaid.get(d.id)?.get(month) ?? 0;
              const left = d.installmentMinor ? debtInstallmentDue(d.installmentMinor, d.balanceMinor, monthPaid).leftMinor : null;
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
                              <input name="amount" required inputMode="decimal" autoComplete="off" defaultValue={left !== null ? (left / 100).toFixed(2) : ''} /></label>
                            {d.installmentMinor ? <small className="muted">{monthPaid > 0 ? `Ya abonaste ${m(monthPaid)} a la cuota de este mes. ` : ''}Si pagas menos que la cuota, queda como abono hasta completarla.</small> : null}
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
          {plan.debts.filter((x) => x.currency === 'PEN' && x.balanceMinor > 0).length > 1 && (
            <details className="card" data-testid="debt-strategies" open={!!payoff}>
              <summary>¿Qué deuda pagar primero?</summary>
              <div className="stack-sm" style={{ marginTop: 8 }}>
                <p className="small"><strong>Avalancha</strong> · primero la de mayor tasa: pagas menos intereses.{' '}
                  {strategies.avalanche.available ? <>Orden: {strategies.avalanche.order.join(' → ')}.</> : <span className="muted">Falta la tasa de {strategies.avalanche.missingRate.join(', ')}.</span>}</p>
                <p className="small"><strong>Bola de nieve</strong> · primero el saldo más pequeño: cierras deudas antes. Orden: {strategies.snowball.order.join(' → ')}.</p>
                <form method="get" className="row" aria-label="Simular pago de deudas">
                  <label className="stack-sm" style={{ flex: 1 }}><span>¿Cuánto puedes pagar al mes?</span>
                    <span className="money-input"><span className="cur" aria-hidden="true">S/</span><input name="cuota" inputMode="decimal" defaultValue={cuota ?? ''} placeholder="600" /></span></label>
                  <button type="submit" className="quiet">Simular</button>
                </form>
                {payoff && (
                  <div data-testid="payoff">
                    {payoff.note && <p className="small muted">{payoff.note}</p>}
                    {payoff.available && (
                      <ul className="list">{payoff.plans.map((p) => (
                        <li key={p.strategy}><span className="setting-text"><span>{p.strategy === 'avalanche' ? 'Avalancha' : p.strategy === 'snowball' ? 'Bola de nieve' : 'Mixta'}</span><small className="muted">{p.why}</small></span>
                          <span className="amount">{p.months === null ? 'No baja' : `${p.months} meses · ${formatMoney({ amountMinor: p.interestMinor!, currency: 'PEN' })} interés`}</span></li>
                      ))}</ul>
                    )}
                    <small className="muted">Simulación: no cambia nada.</small>
                  </div>
                )}
              </div>
            </details>
          )}
        </section>
      )}

      <div className="actions">
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
    </>
  );
}
