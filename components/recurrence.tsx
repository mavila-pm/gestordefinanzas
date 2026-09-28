import { ActionForm } from './action-form';
import { recurrenceAction } from '../app/app/plan/actions';
import { shortDate } from '../src/web/dates';

/** State line for a recurring item: "Pausado hasta 12 nov" / "Terminó el 28 sep" (null when running). */
export function lifecycleNote(r: { pausedUntil?: string | null; endedOn?: string | null }, today: string): string | null {
  if (r.endedOn && r.endedOn <= today) return `Terminó el ${shortDate(r.endedOn)}`;
  if (r.pausedUntil && r.pausedUntil > today) return `Pausado hasta el ${shortDate(r.pausedUntil)}`;
  return null;
}

/** Pause / resume / end a recurring payment or income. Only future planning changes; history stays. */
export function Lifecycle({ kind, id, name, pausedUntil, endedOn, today, defaultUntil }: {
  kind: 'obligation' | 'income'; id: string; name: string; pausedUntil: string | null; endedOn: string | null; today: string; defaultUntil: string;
}) {
  const stopped = !!((endedOn && endedOn <= today) || (pausedUntil && pausedUntil > today));
  const hidden = (op: string) => (<><input type="hidden" name="id" value={id} /><input type="hidden" name="kind" value={kind} /><input type="hidden" name="op" value={op} /></>);
  // One form instance for pause ⇄ resume: it survives the state flip, so the sheet still closes on success.
  return (
    <div className="stack-sm" data-testid={`lifecycle-${kind}`}>
      <ActionForm action={recurrenceAction} className="row" label={`${stopped ? 'Reanudar' : 'Pausar'} ${name}`} closeOnSuccess>
        {hidden(stopped ? 'resume' : 'pause')}
        {!stopped && <label className="stack-sm" style={{ flex: 1 }}><span>Pausar hasta</span><input type="date" name="until" defaultValue={defaultUntil} min={today} required /></label>}
        <button type="submit" className="quiet">{stopped ? 'Reanudar' : 'Pausar'}</button>
      </ActionForm>
      <div hidden={stopped}>{/* kept mounted (hidden) so "end" also closes the sheet on success */}
        <ActionForm action={recurrenceAction} className="inline" label={`Terminar ${name}`} closeOnSuccess>
          {hidden('end')}<button type="submit" className="link">Ya no {kind === 'income' ? 'lo recibo' : 'lo pago'}</button>
        </ActionForm>
      </div>
    </div>
  );
}
