'use client';

import { useState } from 'react';
import { formatMoney, parseAmountToMinor, type Currency } from '../src/domain/money';
import { simulatePurchase } from '../src/engine/planning';

/** "¿Puedo gastar S/500?" — computed in the browser from the plan; never saves or changes anything. */
export function PurchaseSimulator({ freeMinor, currency, estimated }: { freeMinor: number; currency: Currency; estimated: boolean }) {
  const [raw, setRaw] = useState('');
  const amount = raw.trim() ? parseAmountToMinor(raw.trim()) : null;
  const sim = amount ? simulatePurchase({ freeMinor, status: estimated ? 'partial' : 'confirmed' }, amount) : null;
  const m = (v: number) => formatMoney({ amountMinor: Math.abs(v), currency });
  return (
    <section className="stack-sm" aria-labelledby="sim-h" data-testid="simulator">
      <h2 id="sim-h">¿Puedo gastar…?</h2>
      <label className="money-input" style={{ maxWidth: 240 }}>
        <span className="cur" aria-hidden="true">{currency === 'PEN' ? 'S/' : 'US$'}</span>
        <input value={raw} onChange={(e) => setRaw(e.target.value)} inputMode="decimal" autoComplete="off" placeholder="500" aria-label="Monto de la compra" />
      </label>
      <p aria-live="polite" className="small" data-testid="simulation">
        {!raw.trim() ? <span className="muted">Escribe un monto. Solo es una prueba: no se guarda nada.</span>
          : !sim ? <span className="muted">Revisa el monto.</span>
          : sim.covered ? <>Te quedarían <strong>{m(sim.afterMinor)}</strong> libres. Tus próximos pagos siguen cubiertos{estimated ? ' (estimado)' : ''}.</>
          : <span className="error">Esta compra dejaría <strong>{m(sim.shortfallMinor)}</strong> de tus próximos pagos sin cubrir.</span>}
      </p>
    </section>
  );
}
