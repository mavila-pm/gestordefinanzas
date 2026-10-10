import { ActionForm } from './action-form';
import { Sheet } from './ui/sheet';
import { saveCardStatementAction } from '../app/app/actions';
import type { CardView } from '../lib/cards';
import { formatMoney } from '../src/domain/money';
import { shortDate } from '../src/domain/dates';

export function StatementSheet({ v }: { v: CardView }) {
  const s = v.statement;
  const cur = v.currency === 'USD' ? 'US$' : 'S/';
  const amt = (x: number | null | undefined) => (x == null ? '' : (x / 100).toFixed(2));
  const money = (name: string, label: string, value: number | null | undefined, hint?: string) => (
    <label className="stack-sm"><span>{label}</span><span className="money-input"><span className="cur" aria-hidden="true">{cur}</span>
      <input name={name} inputMode="decimal" defaultValue={amt(value)} placeholder={hint} /></span></label>
  );
  return (
    <Sheet label="Estado" triggerClassName="link small-link" triggerLabel={`Estado de cuenta de ${v.name}`} title={`Estado de cuenta · ${v.name}`} subtitle="Cópialo de tu estado de cuenta. Si no sabes un monto, déjalo vacío.">
      <div className="sheet-body">
        <ActionForm action={saveCardStatementAction} label={`Estado de cuenta de ${v.name}`} closeOnSuccess>
          <input type="hidden" name="id" value={v.id} />
          <div className="grid">
            <label className="stack-sm"><span>Fecha de corte</span><input type="date" name="cutDate" required defaultValue={s?.cutDate ?? ''} /></label>
            <label className="stack-sm"><span>Último día de pago</span><input type="date" name="dueDate" required defaultValue={s?.dueDate ?? ''} /></label>
          </div>
          <div className="grid">
            {money('billed', 'Total facturado', s?.billedMinor)}
            {money('minimum', 'Pago mínimo', s?.minimumMinor)}
          </div>
          {money('used', 'Utilizado hoy (opcional)', s?.usedMinor, 'Lo que dice tu app del banco')}
          <small className="muted">No guardamos el número de tu tarjeta ni claves.</small>
          <button type="submit" className="wide">Guardar</button>
        </ActionForm>
      </div>
    </Sheet>
  );
}
