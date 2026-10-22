import { ActionForm } from './action-form';
import { Sheet } from './ui/sheet';
import { formatMoney, type Currency } from '../src/domain/money';
import { shortDate } from '../src/domain/dates';
import { reserveProgress, type Reserve } from '../src/engine/planning';
import { archiveReserveAction, reserveEntryAction, saveReserveAction } from '../app/app/plan/actions';

/**
 * Apartados (ADR-0017): money the person sets aside with a name. Apartar / Usar move money inside their own balance:
 * never an income nor an expense. The numbers come from the engine (reserveProgress) and the server; nothing here
 * computes money.
 */
const sym = (c: Currency) => (c === 'PEN' ? 'S/' : 'US$');

function AmountField({ c, name = 'amount', label, placeholder, defaultValue }: { c: Currency; name?: string; label: string; placeholder?: string; defaultValue?: string }) {
  return (
    <label className="stack-sm"><span>{label}</span><span className="money-input"><span className="cur" aria-hidden="true">{sym(c)}</span>
      <input name={name} inputMode="decimal" autoComplete="off" placeholder={placeholder} defaultValue={defaultValue} required={name === 'amount'} /></span></label>
  );
}

function Move({ r, direction }: { r: Reserve; direction: 'in' | 'out' }) {
  const money = (v: number) => formatMoney({ amountMinor: v, currency: r.currency });
  const apartar = direction === 'in';
  return (
    <Sheet label={apartar ? 'Apartar' : 'Usar'} triggerClassName={apartar ? 'quiet' : 'link small-link'} title={`${apartar ? 'Apartar para' : 'Usar de'} ${r.name}`}
      triggerLabel={`${apartar ? 'Apartar para' : 'Usar de'} ${r.name}`} testId={`reserve-${direction}-${r.id}`} subtitle={<>Llevas {money(r.savedMinor)}</>}>
      <div className="sheet-body">
        <ActionForm action={reserveEntryAction} label={`${apartar ? 'Apartar' : 'Usar'} ${r.name}`} closeOnSuccess>
          <input type="hidden" name="reserveId" value={r.id} />
          <input type="hidden" name="direction" value={direction} />
          <AmountField c={r.currency} label={apartar ? '¿Cuánto apartas?' : '¿Cuánto usas?'} placeholder="200" />
          <small className="muted">{apartar ? 'No es un gasto: sigue en tu saldo, pero deja de estar disponible.' : 'Vuelve a estar disponible en tu saldo.'}</small>
          <button type="submit" className="wide">{apartar ? 'Apartar' : 'Usar'}</button>
        </ActionForm>
      </div>
    </Sheet>
  );
}

function ReserveFields({ r, today }: { r?: Reserve; today: string }) {
  const c = r?.currency ?? 'PEN';
  return (
    <>
      <label className="stack-sm"><span>Nombre</span><input name="name" required maxLength={40} autoComplete="off" placeholder="Viaje" defaultValue={r?.name} /></label>
      {r ? <input type="hidden" name="currency" value={r.currency} /> : (
        <label className="stack-sm"><span>Moneda</span><select name="currency" defaultValue="PEN"><option value="PEN">Soles (S/)</option><option value="USD">Dólares (US$)</option></select></label>
      )}
      <AmountField c={c} name="target" label="Meta (opcional)" placeholder="1200" defaultValue={r?.targetMinor ? (r.targetMinor / 100).toFixed(2) : ''} />
      <label className="stack-sm"><span>¿Para cuándo? (opcional)</span><input type="date" name="targetDate" min={r ? undefined : today} defaultValue={r?.targetDate ?? ''} /></label>
      <small className="muted">Con meta y fecha te decimos cuánto apartar cada mes.</small>
    </>
  );
}

export function Reserves({ reserves, today }: { reserves: readonly Reserve[]; today: string }) {
  const create = (
    <Sheet label={reserves.length ? 'Nuevo' : 'Crear apartado'} triggerClassName={reserves.length ? 'link small-link' : 'quiet'} title="Nuevo apartado" testId="reserve-new"
      subtitle="Dinero que separas para algo concreto.">
      <div className="sheet-body">
        <ActionForm action={saveReserveAction} label="Nuevo apartado" closeOnSuccess>
          <ReserveFields today={today} />
          <button type="submit" className="wide">Crear</button>
        </ActionForm>
      </div>
    </Sheet>
  );
  return (
    <section className="card stack-sm" aria-labelledby="h-reserves" data-testid="reserves">
      <div className="row"><h2 id="h-reserves">Apartados</h2>{reserves.length > 0 && create}</div>
      {reserves.length === 0 ? (
        <>
          <p className="muted">Separa dinero para un viaje, el SOAT o lo que venga. No es un gasto: sigue en tu saldo.</p>
          <div>{create}</div>
        </>
      ) : (
        <ul className="plain budget-list">
          {reserves.map((r) => {
            const p = reserveProgress(r, today);
            const money = (v: number) => formatMoney({ amountMinor: v, currency: r.currency });
            const note = p.targetMinor === null ? 'Sin meta'
              : p.reached ? 'Meta cumplida'
                : [`Faltan ${money(p.remainingMinor!)}`, p.monthlyMinor !== null && r.targetDate
                  ? (p.late ? `la fecha (${shortDate(r.targetDate)}) ya pasó` : p.monthsLeft === 1 ? `antes del ${shortDate(r.targetDate)}` : `${money(p.monthlyMinor)} al mes hasta el ${shortDate(r.targetDate)}`)
                  : null].filter(Boolean).join(' · ');
            return (
              <li key={r.id} className="budget" data-testid="reserve">
                <div className="row" style={{ alignItems: 'baseline' }}>
                  <strong>{r.name}</strong>
                  <span className="amount" data-testid="reserve-saved">{money(r.savedMinor)}{p.targetMinor !== null ? <span className="muted"> de {money(p.targetMinor)}</span> : null}</span>
                </div>
                {p.ratio !== null && <span className="progress" aria-hidden="true"><span className="fill" style={{ width: `${Math.max(2, p.ratio * 100)}%` }} /></span>}
                <small className={p.late ? 'warn' : 'muted'}>{note}</small>
                <div className="actions">
                  <Move r={r} direction="in" />
                  {r.savedMinor > 0 && <Move r={r} direction="out" />}
                  <Sheet label="Editar" triggerClassName="link small-link" title={`Editar ${r.name}`} triggerLabel={`Editar ${r.name}`} testId={`reserve-edit-${r.id}`}>
                    <div className="sheet-body">
                      <ActionForm action={saveReserveAction} label={`Editar ${r.name}`} closeOnSuccess>
                        <input type="hidden" name="id" value={r.id} />
                        <ReserveFields r={r} today={today} />
                        <button type="submit" className="wide">Guardar</button>
                      </ActionForm>
                      {r.savedMinor === 0 && (
                        <ActionForm action={archiveReserveAction} className="inline" label={`Archivar ${r.name}`} closeOnSuccess>
                          <input type="hidden" name="id" value={r.id} />
                          <button type="submit" className="link small-link muted-link">Archivar</button>
                        </ActionForm>
                      )}
                    </div>
                  </Sheet>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
