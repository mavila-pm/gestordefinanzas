import { ActionForm } from './action-form';
import { Sheet } from './ui/sheet';
import { formatMoney } from '../src/domain/money';
import { savingsProgress } from '../src/engine/analysis';
import { saveSavingsGoalAction } from '../app/app/plan/actions';

/**
 * Monthly savings goal (PEN): what was kept this month (income − spending, confirmed) against the goal the person
 * set. No goal → an invitation, never a suggested amount.
 */
export function SavingsGoal({ netMinor, goalMinor, estimated }: { netMinor: number; goalMinor: number | null; estimated: boolean }) {
  const p = savingsProgress(netMinor, goalMinor);
  const money = (v: number) => formatMoney({ amountMinor: v, currency: 'PEN' });
  const edit = (
    <Sheet label={goalMinor ? 'Cambiar' : 'Definir meta'} triggerClassName={goalMinor ? 'link small-link' : 'quiet'} title="Meta de ahorro" testId="savings-sheet"
      subtitle="Cuánto quieres ahorrar cada mes.">
      <div className="sheet-body">
        <ActionForm action={saveSavingsGoalAction} label="Meta de ahorro" closeOnSuccess>
          <input type="hidden" name="currency" value="PEN" />
          <label className="stack-sm"><span>Meta mensual</span><span className="money-input"><span className="cur" aria-hidden="true">S/</span>
            <input name="goal" inputMode="decimal" autoComplete="off" placeholder="500" defaultValue={goalMinor ? (goalMinor / 100).toFixed(2) : ''} /></span></label>
          <small className="muted">Déjalo vacío para quitar la meta.</small>
          <button type="submit" className="wide">Guardar</button>
        </ActionForm>
      </div>
    </Sheet>
  );
  return (
    <section className="card stack-sm" aria-labelledby="h-savings" data-testid="savings-goal">
      <div className="row"><h2 id="h-savings">Meta de ahorro</h2>{p && edit}</div>
      {p ? (
        <>
          <p className="row" style={{ alignItems: 'baseline' }}>
            <strong data-testid="savings-progress">{money(p.savedMinor)} de {money(goalMinor!)}</strong>
            <span className="muted">{Math.round(p.ratio * 100)}%</span>
          </p>
          <span className="progress" aria-hidden="true"><span className="fill" style={{ width: `${Math.max(2, p.ratio * 100)}%` }} /></span>
          <small className="muted">Lo que te queda este mes después de tus gastos{estimated ? ' · estimado' : ''}.</small>
        </>
      ) : (
        <>
          <p className="muted">Define cuánto quieres ahorrar cada mes y te mostramos cómo vas.</p>
          <div>{edit}</div>
        </>
      )}
    </section>
  );
}
