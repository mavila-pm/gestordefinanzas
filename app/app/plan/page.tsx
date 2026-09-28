import Link from 'next/link';
import { ActionForm } from '../../../components/action-form';
import { PurchaseSimulator } from '../../../components/purchase-simulator';
import { Icon } from '../../../components/ui/icon';
import { Sheet } from '../../../components/ui/sheet';
import { essentialsFor, loadEssentialRows, loadPlanningData, planFor, planTimeline } from '../../../lib/planning';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { formatMoney, type Currency } from '../../../src/domain/money';
import type { Plan, PlanLine } from '../../../src/engine/planning';
import { extraDebtPayment } from '../../../src/engine/scenarios';
import { addDays } from '../../../src/engine/planning';
import { Lifecycle, lifecycleNote } from '../../../components/recurrence';
import { shortDate } from '../../../src/web/dates';
import { isUuid } from '../../../src/web/transaction-input';
import {
  acceptEssentialsAction, decideSuggestionAction, linkIncomeAction, removeIncomeAction, markObligationPaidAction, patchObligationAction, recordBalanceAction, resolveVariationAction, saveIncomeAction, saveSettingsAction,
} from './actions';

export const metadata = { title: 'Dinero libre' };
const sym = (c: Currency) => (c === 'PEN' ? 'S/' : 'US$');

function Money({ v, c }: { v: number | null; c: Currency }) {
  return v === null ? <span className="muted">por confirmar</span> : <>{v < 0 ? '−' : ''}{formatMoney({ amountMinor: Math.abs(v), currency: c })}</>;
}

/** "Ahora no" / "Descartar" / "No es ese": hides the suggestion only; nothing else changes. */
function Decide({ kind, subject, value, decision, label }: { kind: string; subject: string; value?: number; decision: 'later' | 'dismissed'; label: string }) {
  return (
    <ActionForm action={decideSuggestionAction} className="inline" label={`${label} ${subject}`}>
      <input type="hidden" name="kind" value={kind} /><input type="hidden" name="subject" value={subject} />
      <input type="hidden" name="decision" value={decision} />{value !== undefined && <input type="hidden" name="value" value={value} />}
      <button type="submit" className="link small-link">{label}</button>
    </ActionForm>
  );
}

function LineRow({ l, c }: { l: PlanLine; c: Currency }) {
  const when = l.date ? (l.dateMax ? `${shortDate(l.date)}–${shortDate(l.dateMax)} aprox.` : shortDate(l.date)) : null;
  return (
    <li>
      <span className="setting-text">
        <span>{l.label}</span>
        <small className={l.kind === 'overdue' ? 'error' : 'muted'}>{[l.kind === 'overdue' ? 'Venció' : when ? `Pagar el ${when}` : null, l.note].filter(Boolean).join(' · ')}</small>
      </span>
      <span className="amount">{l.amountMinor === null ? <span className="muted">por confirmar</span> : <>−<Money v={l.amountMinor} c={c} /></>}</span>
    </li>
  );
}

function Breakdown({ p }: { p: Plan }) {
  const c = p.currency;
  return (
    <details className="card" data-testid="breakdown">
      <summary>Cómo se calculó</summary>
      <ul className="list" style={{ marginTop: 8 }}>
        <li><span>{p.base?.kind === 'income' ? 'Entró' : 'Saldo que indicaste'}</span><span className="amount"><Money v={p.base?.amountMinor ?? null} c={c} /></span></li>
        {p.lines.map((l, i) => <LineRow key={i} l={l} c={c} />)}
        <li><strong>{p.status === 'confirmed' ? 'Libre' : 'Libre estimado'}</strong><strong className="amount"><Money v={p.freeMinor} c={c} /></strong></li>
      </ul>
      <small className="muted">Las reservas son un plan: el dinero sigue en tu cuenta hasta que lo pagues.</small>
    </details>
  );
}

function Headline({ p, testId }: { p: Plan; testId: string }) {
  const c = p.currency;
  if (p.freeMinor === null) return null;
  const negative = p.freeMinor < 0;
  return (
    <section className="hero" aria-label="Dinero libre" data-testid={testId} data-status={p.status}>
      <span className="label">{p.base?.kind === 'income' ? 'Libre de este ingreso' : p.status === 'confirmed' ? 'Dinero libre' : 'Dinero libre estimado'}</span>
      <p className="figure" data-testid={`${testId}-amount`}>{negative ? 'Faltan ' : ''}<Money v={Math.abs(p.freeMinor)} c={c} /></p>
      <small style={{ opacity: .85 }}>
        {p.nextIncome ? `Hasta tu próximo ingreso, el ${shortDate(p.nextIncome.date)}${p.nextIncome.dateMax ? `–${shortDate(p.nextIncome.dateMax)}` : ''}. ` : ''}
        Ya descontamos <strong><Money v={p.reservedMinor} c={c} /></strong> en pagos y reservas.
      </small>
      {p.status !== 'confirmed' && p.missing.length > 0 && <small style={{ opacity: .85 }}>{p.missing.length === 1 ? 'Falta 1 dato por confirmar.' : `Faltan ${p.missing.length} datos por confirmar.`}</small>}
    </section>
  );
}

export default async function PlanPage({ searchParams }: { searchParams: Promise<{ ingreso?: string }> }) {
  const { ingreso } = await searchParams;
  const supabase = await createSupabaseServerClient();
  // One parallel round: the observed-essentials read no longer waits for the plan data.
  const [d, essentialRows] = await Promise.all([loadPlanningData(supabase), loadEssentialRows(supabase)]);
  const currencies = (['PEN', 'USD'] as const).filter((c, i) => i === 0 || d.balances[c] || d.incomes.some((x) => x.currency === c) || d.obligations.some((o) => o.currency === c));
  const incomeId = ingreso && isUuid(ingreso) && d.transactionsById.has(ingreso) ? ingreso : null;
  const incomeTx = incomeId ? d.transactionsById.get(incomeId)! : null;
  const incomeCurrency = d.recentIncome?.transactionId === incomeId ? d.recentIncome!.currency : 'PEN';
  const distribution = incomeId ? planFor(d, incomeCurrency, { transactionId: incomeId }) : null;
  const obligationsById = new Map(d.obligationRows.map((o) => [o.id, o]));
  const essentials = essentialsFor(d, essentialRows);
  const upcoming = planTimeline(d).slice(0, 12);

  return (
    <main className="stack narrow-md">
      <div className="page-head">
        <h1>Dinero libre</h1>
        <p>Lo que puedes usar sin tocar lo que ya tienes que pagar.</p>
      </div>

      {distribution && incomeTx && (
        <section className="stack-sm" aria-label="Distribución del ingreso" data-testid="distribution">
          <h2>Entraron <Money v={incomeTx.amountMinor} c={distribution.currency} /> el {shortDate(incomeTx.occurredOn)}</h2>
          <div className="figures">
            <div><span className="muted small">Reservar</span><p className="big" data-testid="dist-reserved"><Money v={distribution.reservedMinor} c={distribution.currency} /></p></div>
            <div><span className="muted small">{distribution.freeMinor !== null && distribution.freeMinor < 0 ? 'Faltan' : 'Libre'}</span>
              <p className="big" data-testid="dist-free"><Money v={distribution.freeMinor === null ? null : Math.abs(distribution.freeMinor)} c={distribution.currency} /></p></div>
          </div>
          {distribution.lines.length > 0 && (
            <details><summary>Ver pagos</summary>
              <ul className="list">{distribution.lines.map((l, i) => <LineRow key={i} l={l} c={distribution.currency} />)}</ul>
            </details>
          )}
          <Link href="/app/plan" className="section-link">Cerrar distribución</Link>
        </section>
      )}

      {!distribution && d.recentIncome && (
        <p className="notice positive" data-testid="income-event">
          <span>Entraron <strong><Money v={d.recentIncome.amountMinor} c={d.recentIncome.currency} /></strong> el {shortDate(d.recentIncome.date)}.{' '}
            <Link href={`/app/plan?ingreso=${d.recentIncome.transactionId}`}>Ver distribución</Link></span>
        </p>
      )}

      {currencies.map((c) => {
        const p = planFor(d, c);
        const testId = `free-${c}`;
        const payments = p.lines.filter((l) => l.kind === 'payment' || l.kind === 'overdue' || l.kind === 'debt');
        return (
          <div key={c} className="stack">
            {c === 'USD' && <h2>En dólares</h2>}
            <Headline p={p} testId={testId} />
            {p.freeMinor === null && (
              <section className="stack-sm" data-testid={`${testId}-setup`}>
                <p>Para calcular tu dinero libre necesitamos dos datos:</p>
                <ol className="plain stack-sm">
                  <li className="source row"><span className="setting-text"><strong>Cuánto tienes hoy</strong><small className="muted">{d.balances[c] ? 'Listo' : 'El saldo de tu cuenta'}</small></span>
                    <BalanceSheet c={c} current={d.balances[c]?.amountMinor ?? null} /></li>
                  <li className="source row"><span className="setting-text"><strong>Tu próximo ingreso</strong><small className="muted">{p.nextIncome ? 'Listo' : 'Para saber hasta cuándo alcanzar'}</small></span>
                    <IncomeSheet c={c} /></li>
                </ol>
              </section>
            )}
            {p.freeMinor !== null && <Breakdown p={p} />}
            {c === 'PEN' && (() => {
              const x = extraDebtPayment(p, d.debts.filter((y) => y.currency === c), d.settings[c]?.allowZeroForDebt ?? false);
              return x ? (
                <p className="notice" data-testid="extra-debt">
                  <span>{x.target ? <>Puedes abonar <strong><Money v={x.amountMinor} c={c} /></strong> a {x.target}.</> : <>Puedes abonar hasta <strong><Money v={x.amountMinor} c={c} /></strong> a una deuda.</>}
                    {x.usesCushion ? ` Usa tu colchón: quedas en S/ 0 libre${x.until ? ` hasta el ${shortDate(x.until)}` : ''}.` : ''}
                    {x.interestSavedMinor ? ` Evitas ~${formatMoney({ amountMinor: x.interestSavedMinor, currency: c })} de interés al mes.` : ''}{' '}
                    <Link href="/app/compromisos">Ver deudas</Link></span>
                </p>
              ) : null;
            })()}
            {p.freeMinor !== null && <PurchaseSimulator freeMinor={p.freeMinor} currency={c} estimated={p.status !== 'confirmed'} />}

            {p.missing.filter((m) => m.code !== 'balance' && m.code !== 'next_income').length > 0 && (
              <section className="stack-sm" aria-labelledby={`miss-${c}`} data-testid={`missing-${c}`}>
                <h2 id={`miss-${c}`}>Falta confirmar</h2>
                <ul className="list card" style={{ paddingTop: 4, paddingBottom: 4 }}>
                  {p.missing.filter((m) => m.code !== 'balance' && m.code !== 'next_income').map((m, i) => (
                    <li key={i}>
                      <span className="small">{m.text}</span>
                      {m.code === 'amount' && m.obligationId && <FixSheet id={m.obligationId} name={obligationsById.get(m.obligationId)?.name ?? ''} field="amount" c={c} />}
                      {m.code === 'date' && m.obligationId && obligationsById.has(m.obligationId) && <FixSheet id={m.obligationId} name={obligationsById.get(m.obligationId)!.name} field="dueDay" c={c} />}
                      {m.code === 'balance_stale' && <BalanceSheet c={c} current={d.balances[c]?.amountMinor ?? null} />}
                      {m.code === 'essentials' && <SettingsSheet c={c} s={d.settings[c]} />}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {payments.length > 0 && (
              <section className="stack-sm" aria-labelledby={`pay-${c}`}>
                <div className="row"><h2 id={`pay-${c}`}>Antes de tu próximo ingreso</h2><Link href="/app/compromisos" className="section-link">Todos<Icon name="chevron" size={16} /></Link></div>
                <ul className="list card" data-testid={`upcoming-${c}`} style={{ paddingTop: 4, paddingBottom: 4 }}>{payments.map((l, i) => <LineRow key={i} l={l} c={c} />)}</ul>
              </section>
            )}
          </div>
        );
      })}

      {d.suggestions.length > 0 && (
        <section className="stack-sm" aria-label="Pagos detectados" data-testid="match-suggestions">
          <h2>¿Ya pagaste?</h2>
          {d.suggestions.slice(0, 3).map((s) => {
            const t = d.transactionsById.get(s.transactionId);
            const o = obligationsById.get(s.obligationId);
            return (
              <div key={s.transactionId} className="source row">
                <span className="setting-text"><span>{t?.merchant ?? 'Movimiento'} · <Money v={t?.amountMinor ?? null} c={o?.currency ?? 'PEN'} /> · {t ? shortDate(t.occurredOn) : ''}</span>
                  <small className="muted">Parece el pago de {s.name}.</small></span>
                <ActionForm action={markObligationPaidAction} className="inline" label={`Confirmar pago de ${s.name}`}>
                  <input type="hidden" name="obligationId" value={s.obligationId} />
                  <input type="hidden" name="transactionId" value={s.transactionId} />
                  <input type="hidden" name="period" value={s.period} />
                  <button type="submit" className="quiet">Sí, es ese</button>
                </ActionForm>
              </div>
            );
          })}
        </section>
      )}

      {d.incomeMatches.length > 0 && (
        <section className="stack-sm" aria-label="Ingresos detectados" data-testid="income-matches">
          <h2>¿Te pagaron?</h2>
          {d.incomeMatches.slice(0, 3).map((m) => (
            <div key={m.transactionId} className="source row" data-testid="income-match">
              <span className="setting-text"><span>Entraron <Money v={m.receivedMinor} c={m.currency} /> el {shortDate(d.transactionsById.get(m.transactionId)?.occurredOn ?? m.expectedDate)}</span>
                <small className="muted">{m.ambiguous ? '¿Cuál ingreso es?' : `Parece tu ${m.name.toLowerCase()} del ${shortDate(m.expectedDate)}.`}{m.expectedMinor !== null && m.expectedMinor !== m.receivedMinor ? ` Esperabas ${formatMoney({ amountMinor: m.expectedMinor, currency: m.currency })}.` : ''}</small></span>
              <div className="actions">
                {(m.candidates ?? [m]).map((c) => (
                  <ActionForm key={c.incomeId} action={linkIncomeAction} className="inline" label={`Confirmar ingreso ${c.name}`}>
                    <input type="hidden" name="incomeId" value={c.incomeId} />
                    <input type="hidden" name="transactionId" value={m.transactionId} />
                    <input type="hidden" name="period" value={c.period} />
                    <button type="submit" className="quiet">{m.candidates ? `Es ${c.name.toLowerCase()}` : 'Sí, es ese'}</button>
                  </ActionForm>
                ))}
                <Decide kind="income_match" subject={m.transactionId} decision="dismissed" label="No es ese" />
              </div>
            </div>
          ))}
        </section>
      )}

      {d.observedAmounts.length > 0 && (
        <section className="stack-sm" aria-label="Montos observados" data-testid="observed-amounts">
          {d.observedAmounts.map((v) => (
            <div key={v.obligationId} className="source">
              <strong>{v.name}: pagaste <Money v={v.observedMinor} c={v.currency} /></strong>
              <small className="muted">¿Lo usamos para planificar?</small>
              <div className="actions">
                <ActionForm action={resolveVariationAction} className="inline" label={`Usar monto observado de ${v.name}`}>
                  <input type="hidden" name="obligationId" value={v.obligationId} /><input type="hidden" name="period" value={v.period} />
                  <input type="hidden" name="actual" value={v.observedMinor} /><input type="hidden" name="choice" value="update" />
                  <button type="submit" className="quiet">Usar {formatMoney({ amountMinor: v.observedMinor, currency: v.currency })}</button>
                </ActionForm>
                <Decide kind="observed_amount" subject={v.obligationId} value={v.observedMinor} decision="later" label="Ahora no" />
                <Decide kind="observed_amount" subject={v.obligationId} value={v.observedMinor} decision="dismissed" label="Descartar" />
              </div>
            </div>
          ))}
        </section>
      )}

      {essentials && (
        <section className="source" aria-label="Básicos observados" data-testid="essentials-suggestion">
          <strong>Tus básicos vienen siendo <Money v={essentials.observedMinor} c="PEN" /> al mes</strong>
          <small className="muted">Estimaste <Money v={essentials.estimateMinor} c="PEN" />. Es lo que gastaste en comida y transporte ({essentials.months.length} meses).</small>
          <div className="actions">
            <ActionForm action={acceptEssentialsAction} className="inline" label="Usar básicos observados">
              <button type="submit" className="quiet">Usar {formatMoney({ amountMinor: essentials.observedMinor, currency: 'PEN' })}</button>
            </ActionForm>
            <Decide kind="essentials" subject="PEN" value={essentials.observedMinor} decision="later" label="Ahora no" />
            <Decide kind="essentials" subject="PEN" value={essentials.observedMinor} decision="dismissed" label="Descartar" />
          </div>
        </section>
      )}

      {upcoming.length > 0 && (
        <section className="stack-sm" aria-labelledby="timeline" data-testid="timeline">
          <h2 id="timeline">Lo que viene</h2>
          <ul className="list card" style={{ paddingTop: 4, paddingBottom: 4 }}>
            {upcoming.map((t, i) => (
              <li key={i} data-kind={t.kind}>
                <span className="setting-text">
                  <span>{t.label}</span>
                  <small className={t.overdue && t.kind !== 'income' ? 'error' : 'muted'}>
                    {[t.date ? `${shortDate(t.date)}${t.dateMax ? `–${shortDate(t.dateMax)} aprox.` : ''}` : 'Fecha por confirmar',
                      t.kind === 'income' ? (t.overdue ? 'Esperado, aún no registrado' : 'Ingreso esperado') : t.overdue ? 'Venció' : null,
                      t.amountStatus === 'estimated' ? 'estimado' : null].filter(Boolean).join(' · ')}
                  </small>
                </span>
                <span className="amount">{t.amountMinor === null ? <span className="muted">por confirmar</span> : <>{t.kind === 'income' ? '+' : '−'}<Money v={t.amountMinor} c={t.currency} /></>}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {d.variations.length > 0 && (
        <section className="stack-sm" aria-label="Cambios de monto" data-testid="variations">
          {d.variations.map((v) => (
            <div key={v.obligationId} className="source">
              <strong>{v.name} {v.deltaMinor > 0 ? 'subió' : 'bajó'} <Money v={Math.abs(v.deltaMinor)} c={v.currency} /></strong>
              <small className="muted">Esperabas <Money v={v.expectedMinor} c={v.currency} />; el último pago fue <Money v={v.actualMinor} c={v.currency} />.</small>
              <div className="actions">
                {(['update', 'keep'] as const).map((choice) => (
                  <ActionForm key={choice} action={resolveVariationAction} className="inline" label={choice === 'update' ? `Actualizar monto de ${v.name}` : `Mantener monto de ${v.name}`}>
                    <input type="hidden" name="obligationId" value={v.obligationId} /><input type="hidden" name="period" value={v.period} />
                    <input type="hidden" name="actual" value={v.actualMinor} /><input type="hidden" name="choice" value={choice} />
                    <button type="submit" className={choice === 'update' ? 'quiet' : 'link small-link'}>{choice === 'update' ? `Usar ${formatMoney({ amountMinor: v.actualMinor, currency: v.currency })}` : 'Mantener el anterior'}</button>
                  </ActionForm>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="group" aria-labelledby="g-setup">
        <h2 id="g-setup" className="group-title">Datos del cálculo</h2>
        <div className="rows">
          <div className="setting"><span className="setting-text"><strong>Saldo</strong><small className="muted">
            {d.balances.PEN ? <>{formatMoney({ amountMinor: d.balances.PEN.amountMinor, currency: 'PEN' })} al {shortDate(new Date(Date.parse(d.balances.PEN.asOf) - 5 * 3600_000).toISOString().slice(0, 10))}</> : 'Sin indicar'}</small></span>
            <BalanceSheet c="PEN" current={d.balances.PEN?.amountMinor ?? null} /></div>
          <div className="setting"><span className="setting-text"><strong>Ingresos</strong><small className="muted">
            {d.incomes.length ? d.incomes.map((i) => `${i.name}${i.dayOfMonth ? ` · día ${i.dayOfMonth}${i.dayMax ? `–${i.dayMax}` : ''}` : ''}`).join(' · ') : 'Sin indicar'}</small></span>
            <IncomeSheet c="PEN" /></div>
          {d.incomes.map((i) => (
            <div key={i.id} className="setting" data-testid="income-row">
              <span className="setting-text"><span>{i.name}</span>
                <small className="muted">{lifecycleNote(i, d.today) ?? (i.amountMinor === null ? 'Monto por confirmar' : `${i.amountStatus === 'estimated' ? '≈ ' : ''}${formatMoney({ amountMinor: i.amountMinor, currency: i.currency })}`)}</small></span>
              <Sheet label={<Icon name="more" />} triggerClassName="icon" triggerLabel={`Opciones de ${i.name}`} title={i.name} subtitle="Solo cambia lo que planificamos desde hoy.">
                <div className="sheet-body stack">
                  <Lifecycle kind="income" id={i.id} name={i.name} pausedUntil={i.pausedUntil ?? null} endedOn={i.endedOn ?? null} today={d.today} defaultUntil={addDays(d.today, 30)} />
                  <ActionForm action={removeIncomeAction} className="inline" label={`Quitar ${i.name}`} closeOnSuccess>
                    <input type="hidden" name="id" value={i.id} />
                    <button type="submit" className="link" style={{ color: 'var(--semantic-error)' }}>Quitar</button>
                  </ActionForm>
                </div>
              </Sheet>
            </div>
          ))}
          <div className="setting"><span className="setting-text"><strong>Básicos y colchón</strong><small className="muted">
            {d.settings.PEN?.essentialsMonthlyMinor != null ? `${formatMoney({ amountMinor: d.settings.PEN.essentialsMonthlyMinor, currency: 'PEN' })} al mes` : 'Sin indicar'}
            {d.settings.PEN?.cushionMinor ? ` · colchón ${formatMoney({ amountMinor: d.settings.PEN.cushionMinor, currency: 'PEN' })}` : ''}</small></span>
            <SettingsSheet c="PEN" s={d.settings.PEN} /></div>
          <Link href="/app/compromisos" className="setting link-row"><span className="setting-text"><strong>Pagos del mes</strong><small className="muted">{d.obligations.length} registrados</small></span><Icon name="chevron" size={18} /></Link>
        </div>
      </section>
    </main>
  );
}

function BalanceSheet({ c, current }: { c: Currency; current: number | null }) {
  return (
    <Sheet label={current === null ? 'Indicar' : 'Actualizar'} triggerClassName="quiet" triggerLabel={`Indicar saldo en ${c === 'PEN' ? 'soles' : 'dólares'}`} title="¿Cuánto tienes hoy?"
      subtitle="El total en tus cuentas, hoy. Lo usamos solo para este cálculo.">
      <div className="sheet-body">
        <ActionForm action={recordBalanceAction} label={`Saldo ${c}`} closeOnSuccess>
          <input type="hidden" name="currency" value={c} />
          <label className="stack-sm"><span>Saldo</span><span className="money-input"><span className="cur" aria-hidden="true">{sym(c)}</span>
            <input name="amount" required inputMode="decimal" autoComplete="off" placeholder="5000" /></span></label>
          <button type="submit" className="wide">Guardar</button>
        </ActionForm>
      </div>
    </Sheet>
  );
}

function IncomeSheet({ c }: { c: Currency }) {
  return (
    <Sheet label="Agregar" triggerClassName="quiet" triggerLabel="Agregar ingreso" title="Tu próximo ingreso" subtitle="Solo sirve para saber hasta cuándo planificar. No se suma a tu saldo.">
      <div className="sheet-body">
        <ActionForm action={saveIncomeAction} label="Ingreso esperado" closeOnSuccess>
          <input type="hidden" name="currency" value={c} />
          <label className="stack-sm"><span>Nombre</span><input name="name" defaultValue="Sueldo" maxLength={60} /></label>
          <div className="grid">
            <label className="stack-sm"><span>Día del mes</span><input name="dayOfMonth" inputMode="numeric" placeholder="15" /></label>
            <label className="stack-sm"><span>Monto aprox. (opcional)</span><input name="amount" inputMode="decimal" autoComplete="off" /></label>
          </div>
          <details><summary>Más opciones</summary>
            <div className="grid" style={{ paddingTop: 8 }}>
              <label className="stack-sm"><span>Frecuencia</span><select name="frequency" defaultValue="monthly">
                <option value="monthly">Mensual</option><option value="semimonthly">Quincenal (dos días del mes)</option>
                <option value="biweekly">Cada 2 semanas</option><option value="weekly">Semanal</option></select></label>
              <label className="stack-sm"><span>Hasta el día (si varía)</span><input name="dayMax" inputMode="numeric" placeholder="16" /></label>
              <label className="stack-sm"><span>Segundo día (quincenal)</span><input name="secondDay" inputMode="numeric" /></label>
              <label className="stack-sm"><span>Fecha de un pago (semanal)</span><input name="anchorDate" type="date" /></label>
            </div>
          </details>
          <button type="submit" className="wide">Guardar</button>
        </ActionForm>
      </div>
    </Sheet>
  );
}

function SettingsSheet({ c, s }: { c: Currency; s: { essentialsMonthlyMinor: number | null; cushionMinor: number; allowZeroForDebt: boolean } | undefined }) {
  const v = (m: number | null | undefined) => (m == null ? '' : (m / 100).toFixed(2));
  return (
    <Sheet label="Indicar" triggerClassName="quiet" triggerLabel="Indicar básicos y colchón" title="Lo básico y tu colchón"
      subtitle="Lo básico: comida, transporte, lo del día a día. El colchón: lo que prefieres no tocar.">
      <div className="sheet-body">
        <ActionForm action={saveSettingsAction} label="Básicos y colchón" closeOnSuccess>
          <input type="hidden" name="currency" value={c} />
          <label className="stack-sm"><span>Lo básico, al mes</span><span className="money-input"><span className="cur" aria-hidden="true">{sym(c)}</span>
            <input name="essentials" inputMode="decimal" defaultValue={v(s?.essentialsMonthlyMinor)} placeholder="800" /></span></label>
          <label className="stack-sm"><span>Colchón</span><span className="money-input"><span className="cur" aria-hidden="true">{sym(c)}</span>
            <input name="cushion" inputMode="decimal" defaultValue={v(s?.cushionMinor)} placeholder="400" /></span></label>
          <label className="row" style={{ justifyContent: 'flex-start', gap: 12 }}><input type="checkbox" name="allowZero" defaultChecked={s?.allowZeroForDebt} />
            <span>Si pago deuda, puedo quedarme en cero</span></label>
          <button type="submit" className="wide">Guardar</button>
        </ActionForm>
      </div>
    </Sheet>
  );
}

function FixSheet({ id, name, field, c }: { id: string; name: string; field: 'amount' | 'dueDay'; c: Currency }) {
  return (
    <Sheet label="Completar" triggerClassName="link small-link" triggerLabel={`Completar ${field === 'amount' ? 'monto' : 'fecha'} de ${name}`} title={name}>
      <div className="sheet-body">
        <ActionForm action={patchObligationAction} label={`Completar ${name}`} closeOnSuccess>
          <input type="hidden" name="id" value={id} />
          {field === 'amount'
            ? <label className="stack-sm"><span>Monto</span><span className="money-input"><span className="cur" aria-hidden="true">{sym(c)}</span><input name="amount" required inputMode="decimal" autoComplete="off" /></span></label>
            : <label className="stack-sm"><span>Vence el día</span><input name="dueDay" required inputMode="numeric" placeholder="10" /></label>}
          <button type="submit" className="wide">Guardar</button>
        </ActionForm>
      </div>
    </Sheet>
  );
}
