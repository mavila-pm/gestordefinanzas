'use client';

import { useState } from 'react';
import { CardVisual } from './card-visual';

/**
 * New card in two short steps with a live preview: 1) identity (alias, type, bank, currency, last 4 digits);
 * 2) only for credit and optional: corte, pago, línea. Never asks for the full number, CVV, PIN, OTP or passwords;
 * a long digit run in the alias is refused by the server. Fields only — the parent ActionForm posts them.
 */
export function CardFormFields() {
  const [alias, setAlias] = useState('');
  const [kind, setKind] = useState<'credit' | 'debit'>('credit');
  const [institution, setInstitution] = useState('BCP');
  const [currency, setCurrency] = useState<'PEN' | 'USD'>('PEN');
  const [last4, setLast4] = useState('');
  const [step, setStep] = useState<1 | 2>(1);
  const digits = /^\d{4}$/.test(last4) ? last4 : null;
  return (
    <div className="stack">
      <div className="cv-preview"><CardVisual alias={alias} institution={institution || null} kind={kind} currency={currency} last4={digits} size="lg" /></div>
      <div className="stack" hidden={step !== 1}>
        <label className="stack-sm"><span>Nombre</span><input name="alias" required maxLength={60} placeholder="Visa Signature" value={alias} onChange={(e) => setAlias(e.target.value)} /></label>
        <fieldset className="segmented bare"><legend>Tipo</legend>
          <div className="segments" role="radiogroup">
            {(['credit', 'debit'] as const).map((k) => (
              <label key={k} className="segment"><input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} /><span>{k === 'credit' ? 'Crédito' : 'Débito'}</span></label>
            ))}
          </div>
        </fieldset>
        <div className="field-row">
          <label className="stack-sm"><span>Banco</span>
            <select name="institution" value={institution} onChange={(e) => setInstitution(e.target.value)}>
              <option value="BCP">BCP</option><option value="BBVA">BBVA</option><option value="INTERBANK">Interbank</option><option value="">Otro</option></select></label>
          <label className="stack-sm"><span>Moneda</span>
            <select name="currency" value={currency} onChange={(e) => setCurrency(e.target.value as 'PEN' | 'USD')}>
              <option value="PEN">Soles (S/)</option><option value="USD">Dólares (US$)</option></select></label>
        </div>
        <label className="stack-sm"><span>Últimos 4 dígitos</span>
          <input name="last4" required inputMode="numeric" pattern="\d{4}" maxLength={4} autoComplete="off" value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))} />
          <small className="muted">Solo los 4 últimos. Nunca el número completo, CVV, PIN ni claves.</small></label>
        {kind === 'credit'
          ? <button type="button" className="wide" disabled={!alias.trim() || !digits} onClick={() => setStep(2)}>Continuar</button>
          : <button type="submit" className="wide">Agregar tarjeta</button>}
      </div>
      {kind === 'credit' && (
        <div className="stack" hidden={step !== 2}>
          <p className="muted small">Opcional: con estos datos Vels te dice cuándo pagas lo que compras. Puedes completarlos después.</p>
          <div className="field-row">
            <label className="stack-sm"><span>Día de corte</span><input name="statementDay" inputMode="numeric" maxLength={2} placeholder="20" /></label>
            <label className="stack-sm"><span>Día de pago</span><input name="paymentDay" inputMode="numeric" maxLength={2} placeholder="5" /></label>
          </div>
          <label className="stack-sm"><span>Línea del banco</span><span className="money-input"><span className="cur" aria-hidden="true">{currency === 'USD' ? 'US$' : 'S/'}</span>
            <input name="limit" inputMode="decimal" placeholder="10000" /></span>
            <small className="muted">La línea no es dinero disponible. Lo usado lo registras con tu estado de cuenta.</small></label>
          <div className="row"><button type="button" className="link" onClick={() => setStep(1)}>Atrás</button><button type="submit">Agregar tarjeta</button></div>
        </div>
      )}
    </div>
  );
}
