import { ActionForm } from './action-form';
import { Sheet } from './ui/sheet';
import { saveCardStatementAction } from '../app/app/actions';
import type { CardView } from '../lib/cards';
import { formatMoney } from '../src/domain/money';
import { shortDate } from '../src/domain/dates';

/** ADR-0014: facturado ≠ post-corte ≠ línea ≠ usable; unknown shown as "por confirmar", never 0. */
export function CardPositionSummary({ v }: { v: CardView }) {
  const p = v.position;
  const m = (x: number | null) => (x === null ? 'por confirmar' : formatMoney({ amountMinor: x, currency: v.currency }));
  const rows: string[] = [];
  if (p.billed) {
    const due = p.billed.daysLeft < 0 ? `venció el ${shortDate(p.billed.dueDate)}` : p.billed.daysLeft === 0 ? 'vence hoy' : `vence el ${shortDate(p.billed.dueDate)} (en ${p.billed.daysLeft} día${p.billed.daysLeft > 1 ? 's' : ''})`;
    rows.push(`Facturado ${m(p.billed.amountMinor)} · ${due}`);
    rows.push(`Mínimo ${m(p.billed.minimumMinor)}${p.minimumOnly ? ` · si pagas solo el mínimo pasan ${m(p.minimumOnly.carriedMinor)} al próximo ciclo${p.minimumOnly.interestMinor ? ` (~${m(p.minimumOnly.interestMinor)} de interés)` : ' con interés'}` : ''}`);
    if (p.postCutMinor !== null && p.postCutMinor > 0) rows.push(`Después del corte: ${m(p.postCutMinor)} (va al próximo estado)`);
  } else if (p.statementOutdated) rows.push('Tu estado de cuenta es de un corte anterior. Agrega el nuevo.');
  if (p.limitMinor !== null && p.usedMinor !== null) rows.push(`Línea ${m(p.limitMinor)} · utilizado ${m(p.usedMinor)} · disponible ${m(p.bankAvailableMinor)}`);
  if (p.usableMinor !== null && (p.billed || p.limitMinor !== null)) rows.push(`Sin romper tu plan puedes usar ${m(p.usableMinor)}`);
  if (p.purchaseTodayPaidOn) rows.push(`Lo que compres hoy se paga el ${shortDate(p.purchaseTodayPaidOn)}`);
  if (!rows.length) return null;
  return <span className="stack-xs card-position" data-testid="card-position">{rows.map((r, i) => <small key={i} className="muted">{r}</small>)}</span>;
}

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
