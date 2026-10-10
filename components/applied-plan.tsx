import { ActionForm } from './action-form';
import { applyPlanAction, cancelPlanAction } from '../app/app/plan/actions';
import { reconcile, type AppliedPlan, type LineState } from '../src/engine/applied';
import type { Plan } from '../src/engine/planning';
import { formatMoney, type Currency } from '../src/domain/money';
import { shortDate } from '../src/domain/dates';

const m = (v: number, c: Currency) => formatMoney({ amountMinor: Math.abs(v), currency: c });
const STATE: Record<LineState, string> = { realized: 'Pagado', pending: 'Pendiente', late: 'Atrasado', reserved: 'Reservado' };

/** "Aplicar plan" (ADR-0013): save the reservations; never pays or moves money. */
export function ApplyPlan({ p, income, label = 'Aplicar plan' }: { p: Plan; income?: string; label?: string }) {
  if (p.status === 'incomplete' || p.freeMinor === null) return null;
  return (
    <ActionForm action={applyPlanAction} className="inline" label={`${label} ${p.currency}`}>
      <input type="hidden" name="currency" value={p.currency} />
      {income && <input type="hidden" name="income" value={income} />}
      <input type="hidden" name="seenFree" value={p.freeMinor} />
      <input type="hidden" name="seenReserved" value={p.reservedMinor} />
      <button type="submit" className="quiet" data-testid={`apply-${p.currency}`}>{label}</button>
    </ActionForm>
  );
}

export function AppliedPlanCard({ p, applied, history, settled, today }: {
  p: Plan; applied: AppliedPlan | undefined; history: AppliedPlan[]; settled: ReadonlyMap<string, ReadonlySet<string>>; today: string;
}) {
  const c = p.currency;
  const r = applied ? reconcile(applied, today, settled) : null;
  const live = r && !r.expired ? r : null;
  const past = history.filter((h) => h.currency === c);
  const changed = live && live.plan.baseKind === 'balance' && p.freeMinor !== null && (p.freeMinor !== live.plan.freeMinor || p.reservedMinor !== live.plan.reservedMinor);
  return (
    <section className="stack-sm" aria-label={`Plan aplicado ${c}`} data-testid={`applied-${c}`}>
      {live ? (
        <div className="card stack-sm" data-state="active">
          <div className="row">
            <h2>Plan aplicado</h2>
            <small className="muted">hasta el {shortDate(live.plan.untilDate)}</small>
          </div>
          <div className="figures">
            <div><span className="muted small">Comprometido</span><p data-testid={`applied-committed-${c}`}>{m(live.committedMinor, c)}</p></div>
            <div><span className="muted small">Reservado</span><p>{m(live.reservedMinor, c)}</p></div>
            <div><span className="muted small">Pagado</span><p data-testid={`applied-realized-${c}`}>{m(live.realizedMinor, c)}</p></div>
            <div><span className="muted small">{live.plan.freeMinor < 0 ? 'Faltaban' : 'Libre'}</span><p data-testid={`applied-free-${c}`}>{m(live.plan.freeMinor, c)}</p></div>
          </div>
          <ul className="list">
            {live.lines.map((l, i) => (
              <li key={i} data-state={l.state}>
                <span className="setting-text"><span>{l.label}</span>
                  <small className={l.state === 'late' ? 'error' : 'muted'}>{[STATE[l.state], l.date && l.state !== 'reserved' ? shortDate(l.date) : null].filter(Boolean).join(' · ')}</small></span>
                <span className="amount">{l.amountMinor === null ? <span className="muted">por confirmar</span> : m(l.amountMinor, c)}</span>
              </li>
            ))}
          </ul>
          <small className="muted">{live.unknownCount > 0 ? `${live.unknownCount} monto${live.unknownCount > 1 ? 's' : ''} por confirmar. ` : ''}Es un plan: el dinero sigue en tu cuenta. Se marca pagado cuando vinculas el movimiento real.</small>
          {changed && <p className="notice small" data-testid={`applied-changed-${c}`}>Tus datos cambiaron desde que lo aplicaste.</p>}
          <div className="actions">
            {changed && <ApplyPlan p={p} label="Actualizar plan" />}
            <ActionForm action={cancelPlanAction} className="inline" label={`Quitar plan ${c}`}>
              <input type="hidden" name="id" value={live.plan.id} />
              <button type="submit" className="link small-link">Quitar plan</button>
            </ActionForm>
          </div>
        </div>
      ) : p.status !== 'incomplete' && p.freeMinor !== null && (
        <div className="source row">
          <span className="setting-text"><span>¿Te sirve este plan?</span>
            <small className="muted">{r?.expired ? `Tu plan anterior terminó el ${shortDate(r.plan.untilDate)}. ` : ''}Guarda estas reservas. No paga ni mueve dinero.</small></span>
          <ApplyPlan p={p} />
        </div>
      )}
      {past.length > 0 && (
        <details className="small" data-testid={`applied-history-${c}`}>
          <summary>Planes anteriores</summary>
          <ul className="list">
            {past.map((h) => (
              <li key={h.id}><span>{shortDate(new Date(Date.parse(h.createdAt) - 5 * 3600_000).toISOString().slice(0, 10))} → {shortDate(h.untilDate)}</span>
                <span className="muted">{h.status === 'cancelled' ? 'Quitado' : 'Reemplazado'} · libre {m(h.freeMinor, c)}</span></li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
