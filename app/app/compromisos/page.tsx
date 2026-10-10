import Link from 'next/link';
import { ActionForm } from '../../../components/action-form';
import { plural } from '../../../src/domain/plural';
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
import { removeObligationAction, saveObligationAction, skipOccurrenceAction } from '../plan/actions';
import { Lifecycle, lifecycleNote } from '../../../components/recurrence';
import { openOccurrence } from '../../../src/engine/planning';
import { addDays } from '../../../src/domain/dates';
import { ObligationFields } from '../../../components/obligation-fields';
import { loadPlanningData } from '../../../lib/planning';
import { compareDebtStrategies } from '../../../src/engine/planning';
import { previousMonth } from '../../../src/engine/analysis';
import { comparePayoff } from '../../../src/engine/scenarios';
import { parseAmountToMinor } from '../../../src/domain/money';
import { shortDate } from '../../../src/domain/dates';

export const metadata = { title: 'Próximos pagos' };
const CUR = <><option value="PEN">Soles (S/)</option><option value="USD">Dólares (US$)</option></>;

export default async function Commitments({ searchParams }: { searchParams: Promise<{ cuota?: string }> }) {
  const { cuota } = await searchParams;
  const supabase = await createSupabaseServerClient();
  const [{ fixed, debts }, , { entitlements }, plan, hist] = await Promise.all([loadCommitmentData(supabase), loadCatalog(supabase), loadEntitlements(supabase), loadPlanningData(supabase),
    supabase.from('plan_settlements').select('fixed_expense_id,period,tx:transactions(amount_minor)').not('fixed_expense_id', 'is', null).order('period', { ascending: false }).limit(300)]);
  // Real history per payment (what was actually paid, by month): editing the plan never rewrites it.
  const history = new Map<string, Array<{ period: string; amountMinor: number | null }>>();
  for (const h of (hist.data ?? []) as unknown as Array<{ fixed_expense_id: string; period: string; tx: { amount_minor: number } | null }>) {
    const list = history.get(h.fixed_expense_id) ?? [];
    if (list.length < 6) list.push({ period: h.period, amountMinor: h.tx ? Number(h.tx.amount_minor) : null });
    history.set(h.fixed_expense_id, list);
  }
  const rows = new Map(plan.obligationRows.map((o) => [o.id, o]));
  const paidThisMonth = (id: string) => plan.settledObligations.get(id)?.has(limaMonth()) ?? false;
  const strategies = compareDebtStrategies(plan.debts.filter((x) => x.currency === 'PEN'));
  // "¿En cuánto salgo de deudas?" — simulated for the monthly amount the person types (GET, nothing is written).
  const budgetMinor = cuota ? parseAmountToMinor(cuota) : null;
  const installments = new Map(debts.map((d) => [d.id, d.installmentMinor]));
  const payoff = budgetMinor ? comparePayoff(plan.debts.filter((x) => x.currency === 'PEN').map((x) => ({ ...x, minimumMinor: installments.get(x.id) ?? null })), budgetMinor) : null;
  const month = limaMonth();
  // Plus feature: decided and computed on the server only (§84).
  const recurring = entitlements.features.recurringDetection ? await loadRecurring(supabase, month, fixed) : null;
  const today = formatLimaDateTime(new Date().toISOString()).slice(0, 10).split('/').reverse().join('-');
  const items = monthCommitments(month, today, fixed, debts);
  const totals = totalsByCurrency(items);
  // Próximos: from today, this month and the first days of next month (≈ 5 weeks), in date order.
  const nextMonth = previousMonth(month, -1);
  const horizon = addDays(today, 35);
  const upcoming = [...items.filter((c) => c.daysUntil >= 0 || !paidThisMonth(c.id)), ...monthCommitments(nextMonth, today, fixed, debts)]
    .filter((c) => c.dueDate <= horizon)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name));
  const activeFixed = fixed.filter((f) => f.active);
  const activeDebts = debts.filter((d) => d.active);
  const total = Object.entries(totals).map(([cur, v]) => formatMoney({ amountMinor: v!, currency: cur as 'PEN' | 'USD' })).join(' + ');

  return (
    <main className="stack narrow-md">
      <div className="page-head">
        <h1>Próximos pagos</h1>
        <p>{items.length ? <>Estos son tus próximos pagos. <span data-testid="commitment-total">Total del mes: {total}</span></> : 'Anota tus pagos fijos y deudas para verlos venir.'}</p>
      </div>

      {upcoming.length > 0 && (
        <section aria-labelledby="h-next" className="stack-sm">
          <h2 id="h-next">Próximos</h2>
          <ul className="list card next-list" data-testid="commitment-list" style={{ paddingTop: 4, paddingBottom: 4 }}>
            {upcoming.map((c) => (
              <li key={`${c.kind}-${c.id}-${c.dueDate}`}>
                <span className="next-day">{shortDate(c.dueDate)}</span>
                <span className="setting-text"><span>{c.name}</span>
                  {(c.daysUntil < 0 || c.daysUntil <= 3) && <small className={c.daysUntil < 0 ? 'error' : 'warn'}>
                    {c.daysUntil < 0 ? 'Venció' : c.daysUntil === 0 ? 'Vence hoy' : `Vence en ${plural(c.daysUntil, 'día', 'días')}`}</small>}</span>
                <span className="actions" style={{ gap: 8 }}>
                  {c.dueDate.startsWith(month) && paidThisMonth(c.id) && <span className="tag positive-tag">Pagado</span>}
                  <span className="amount">{c.amountMinor === null ? <span className="muted">Por confirmar</span> : formatMoney({ amountMinor: c.amountMinor, currency: c.currency })}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="h-recurring" className="stack-sm">
        <div className="row"><h2 id="h-recurring">Recurrentes</h2></div>
      {activeFixed.length > 0 && (
        <section aria-labelledby="h-fixed" className="stack-sm">
          <h3 id="h-fixed" className="sub-title">Tus pagos fijos</h3>
          <ul className="list card" data-testid="obligation-list" style={{ paddingTop: 4, paddingBottom: 4 }}>
            {activeFixed.map((f) => {
              const r = rows.get(f.id);
              const when = !r ? '' : r.dueDay === null ? 'Fecha por confirmar'
                : `${r.frequency === 'monthly' ? 'Cada mes' : r.frequency === 'yearly' ? 'Cada año' : r.frequency === 'quarterly' ? 'Cada 3 meses' : 'Cada 2 meses'} · ${r.dueDayMax ? `vence el ${r.dueDay}–${r.dueDayMax} aprox.` : `vence el ${r.dueDay}`}${r.targetDay ? ` · pagas el ${r.targetDay}` : ''}`;
              const state = r ? lifecycleNote(r, plan.today) : null;
              const past = history.get(f.id) ?? [];
              const open = r && !state ? openOccurrence(r, plan.today, plan.settledObligations.get(f.id) ?? new Set()) : null;
              return (
                <li key={f.id} data-name={f.name} data-state={state ? 'stopped' : 'active'}>
                  <span className="setting-text"><span>{f.name}</span><small className="muted">{state ?? when}</small></span>
                  <span className="actions" style={{ gap: 4 }}>
                    <span className="amount">{f.amountMinor === null ? <span className="muted">Por confirmar</span> : <>{r?.amountStatus === 'estimated' ? '≈ ' : ''}{formatMoney({ amountMinor: f.amountMinor, currency: f.currency })}</>}</span>
                    <Sheet label={<Icon name="more" />} triggerClassName="icon" triggerLabel={`Editar ${f.name}`} title={f.name}>
                      <div className="sheet-body stack">
                        <ActionForm action={saveObligationAction} label={`Editar ${f.name}`} closeOnSuccess>
                          <input type="hidden" name="id" value={f.id} />
                          <ObligationFields v={{ name: f.name, kind: r?.kind, currency: f.currency, amount: f.amountMinor === null ? '' : (f.amountMinor / 100).toFixed(2),
                            amountUnknown: f.amountMinor === null, amountEstimated: r?.amountStatus === 'estimated', frequency: r?.frequency, anchorMonth: r?.anchorMonth,
                            dueDay: r?.dueDay ?? null, dueDayMax: r?.dueDayMax ?? null, targetDay: r?.targetDay ?? null }} />
                          <button type="submit" className="wide">Guardar</button>
                        </ActionForm>
                        <small className="muted">Los cambios aplican desde ahora. Lo ya pagado no cambia.</small>
                        {open && (
                          <ActionForm action={skipOccurrenceAction} className="inline" label={`Omitir ${f.name} ${open.period}`} closeOnSuccess>
                            <input type="hidden" name="obligationId" value={f.id} /><input type="hidden" name="period" value={open.period} />
                            <button type="submit" className="quiet">No lo pago {open.dueDate ? `el ${shortDate(open.dueDate)}` : 'este mes'}</button>
                          </ActionForm>
                        )}
                        <Lifecycle kind="obligation" id={f.id} name={f.name} pausedUntil={r?.pausedUntil ?? null} endedOn={r?.endedOn ?? null} today={plan.today} defaultUntil={addDays(plan.today, 30)} />
                        {past.length > 0 && (
                          <details><summary>Historial</summary>
                            <ul className="list" data-testid="obligation-history">{past.map((h) => (
                              <li key={h.period}><span>{h.period}</span><span className="amount">{h.amountMinor === null ? 'Omitido' : formatMoney({ amountMinor: h.amountMinor, currency: f.currency })}</span></li>
                            ))}</ul>
                          </details>
                        )}
                        <ActionForm action={removeObligationAction} className="inline" label={`Quitar ${f.name}`} closeOnSuccess>
                          <input type="hidden" name="id" value={f.id} />
                          <button type="submit" className="link" style={{ color: 'var(--semantic-error)' }}>Quitar este pago</button>
                        </ActionForm>
                      </div>
                    </Sheet>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="stack-sm" data-testid="recurring" aria-labelledby="h-rec">
        <h3 id="h-rec" className="sub-title">Detectados en tus movimientos</h3>
        {!entitlements.features.recurringDetection ? (
          <p className="muted small">En Plus detectamos los cobros que se repiten.</p>
        ) : recurring === null ? <p role="alert" className="error">No pudimos revisar tus movimientos. Intenta de nuevo.</p>
          : recurring.length === 0 ? <p className="muted small">Aún no vemos cobros que se repitan.</p> : (
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
      <div className="actions">
        <Sheet label={<><Icon name="add" size={18} />Agregar pago</>} triggerClassName="quiet" title="Nuevo pago" subtitle="Algo que pagas cada mes: alquiler, carro, internet." testId="fixed-sheet">
          <div className="sheet-body">
            <ActionForm action={saveObligationAction} label="Agregar pago" closeOnSuccess>
              <ObligationFields />
              <button type="submit" className="wide">Agregar</button>
            </ActionForm>
          </div>
        </Sheet>
      </div>
      </section>

      <section aria-labelledby="deudas-h" className="stack-sm" id="deudas">
        <h2 id="deudas-h">Tarjetas y préstamos</h2>
      {activeDebts.length > 0 && (
        <section aria-labelledby="h-debts" className="stack-sm">
          <h3 id="h-debts" className="sub-title">Deudas</h3>
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

        <Link href="/app/tarjetas" className="section-link">Ver tus tarjetas<Icon name="chevron" size={16} /></Link>
      </section>
    </main>
  );
}
