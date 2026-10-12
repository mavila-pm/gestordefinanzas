import { KIND_LABEL } from '../src/web/planning-input';

export interface ObligationValues {
  name?: string; kind?: string; currency?: string; amount?: string; amountUnknown?: boolean; amountEstimated?: boolean; frequency?: string;
  anchorMonth?: number | null; dueDay?: number | null; dueDayMax?: number | null; targetDay?: number | null;
}

/** "Carro · S/950 · vence el 10 · quiero pagarlo el 7" and done; the rest lives behind "Más opciones". */
export function ObligationFields({ v = {} }: { v?: ObligationValues }) {
  const n = (x: number | null | undefined) => (x == null ? '' : String(x));
  return (
    <>
      <label className="stack-sm"><span>Nombre</span><input name="name" required maxLength={60} placeholder="Carro" defaultValue={v.name} /></label>
      <div className="grid">
        <label className="stack-sm"><span>Monto</span><input name="amount" inputMode="decimal" autoComplete="off" placeholder="950.00" defaultValue={v.amount} /></label>
        <label className="stack-sm"><span>Vence el día</span><input name="dueDay" inputMode="numeric" placeholder="10" defaultValue={n(v.dueDay)} /></label>
        <label className="stack-sm"><span>Quiero pagarlo el</span><input name="targetDay" inputMode="numeric" placeholder="7" defaultValue={n(v.targetDay)} /></label>
      </div>
      <label className="check"><input type="checkbox" name="amountUnknown" value="1" defaultChecked={v.amountUnknown} /><span>Aún no sé el monto</span></label>
      <details>
        <summary>Más opciones</summary>
        <div className="stack-sm" style={{ paddingTop: 8, gap: 12 }}>
          <label className="check"><input type="checkbox" name="amountEstimated" value="1" defaultChecked={v.amountEstimated} /><span>El monto es aproximado (varía cada mes)</span></label>
          <label className="check"><input type="checkbox" name="dateUnknown" value="1" defaultChecked={v.dueDay === null && !!v.name} /><span>Aún no sé la fecha</span></label>
          <div className="grid">
            <label className="stack-sm"><span>Hasta el día (si no estás seguro)</span><input name="dueDayMax" inputMode="numeric" placeholder="10" defaultValue={n(v.dueDayMax)} /></label>
            <label className="stack-sm"><span>Cada cuánto</span><select name="frequency" defaultValue={v.frequency ?? 'monthly'}>
              <option value="monthly">Cada mes</option><option value="bimonthly">Cada 2 meses</option><option value="quarterly">Cada 3 meses</option><option value="yearly">Una vez al año</option></select></label>
            <label className="stack-sm"><span>Mes en que vence (si no es mensual)</span><input name="anchorMonth" inputMode="numeric" placeholder="1–12" defaultValue={n(v.anchorMonth)} /></label>
            <label className="stack-sm"><span>Tipo</span><select name="kind" defaultValue={v.kind ?? 'other'}>
              {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            <label className="stack-sm"><span>Moneda</span><select name="currency" defaultValue={v.currency ?? 'PEN'}><option value="PEN">Soles (S/)</option><option value="USD">Dólares (US$)</option></select></label>
          </div>
        </div>
      </details>
    </>
  );
}
