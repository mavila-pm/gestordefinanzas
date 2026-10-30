'use client';

import { useState } from 'react';
import { CardVisual } from './card-visual';
import { BANKS, CARD_COLORS, COLOR_LABEL, MAX_ACCOUNTS, type CardColor } from '../src/web/money-source-input';

/**
 * New card in two short steps with a live preview (CR-001):
 *  1) identity: name, colour, type, bank (or the name of another bank), last 4 digits, expiry MM/AA;
 *  2) credit: currency, line, line used today, cut and payment days · debit: the accounts inside it (name, currency,
 *     balance today), "Agregar otra cuenta".
 * Never asks for the full number, CVV, PIN, OTP or passwords. Fields only — the parent ActionForm posts them.
 */
export function CardFormFields() {
  const [alias, setAlias] = useState('');
  const [kind, setKind] = useState<'credit' | 'debit'>('debit');
  const [bank, setBank] = useState('BCP');
  const [bankName, setBankName] = useState('');
  const [currency, setCurrency] = useState<'PEN' | 'USD'>('PEN');
  const [color, setColor] = useState<CardColor>('black');
  const [last4, setLast4] = useState('');
  const [expiry, setExpiry] = useState('');
  const [step, setStep] = useState<1 | 2>(1);
  const [rows, setRows] = useState(1);
  const [firstCurrency, setFirstCurrency] = useState<'PEN' | 'USD'>('PEN');
  const digits = /^\d{4}$/.test(last4) ? last4 : null;
  const ready = alias.trim() && digits && (bank !== 'OTHER' || bankName.trim());
  const shownCurrency = kind === 'credit' ? currency : firstCurrency;
  return (
    <div className="stack">
      <div className="cv-preview">
        <CardVisual alias={alias} institution={bank === 'OTHER' ? null : bank} bankName={bank === 'OTHER' ? bankName : null} kind={kind}
          currency={shownCurrency} last4={digits} color={color} expiry={/^\d{2}\/\d{2}$/.test(expiry) ? expiry : null} size="lg" />
      </div>
      <div className="stack" hidden={step !== 1}>
        <label className="stack-sm"><span>Nombre de la tarjeta</span><input name="alias" required maxLength={60} placeholder="Visa Signature" value={alias} onChange={(e) => setAlias(e.target.value)} /></label>
        <fieldset className="bare stack-sm"><legend>Color</legend>
          <div className="swatches" role="radiogroup" aria-label="Color de la tarjeta">
            {CARD_COLORS.map((c) => (
              <label key={c} className="swatch" data-color={c} title={COLOR_LABEL[c]}>
                <input type="radio" name="color" value={c} checked={color === c} onChange={() => setColor(c)} />
                <span className="sr-only">{COLOR_LABEL[c]}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="segmented bare"><legend>Tipo</legend>
          <div className="segments" role="radiogroup">
            {(['debit', 'credit'] as const).map((k) => (
              <label key={k} className="segment"><input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} /><span>{k === 'credit' ? 'Crédito' : 'Débito'}</span></label>
            ))}
          </div>
        </fieldset>
        <label className="stack-sm"><span>Banco</span>
          <select name="bank" value={bank} onChange={(e) => setBank(e.target.value)}>
            {BANKS.map((b) => <option key={b.code} value={b.code}>{b.label}</option>)}
          </select></label>
        {bank === 'OTHER' && (
          <label className="stack-sm"><span>Nombre del banco</span>
            <input name="bankName" required maxLength={40} placeholder="Caja Arequipa" value={bankName} onChange={(e) => setBankName(e.target.value)} /></label>
        )}
        <div className="field-row">
          <label className="stack-sm"><span>Últimos 4 dígitos</span>
            <input name="last4" required inputMode="numeric" pattern="\d{4}" maxLength={4} autoComplete="off" value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))} /></label>
          <label className="stack-sm"><span>Vence (MM/AA)</span>
            <input name="expiry" inputMode="numeric" maxLength={5} placeholder="08/29" autoComplete="off" value={expiry}
              onChange={(e) => { const d = e.target.value.replace(/\D/g, '').slice(0, 4); setExpiry(d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d); }} /></label>
        </div>
        <small className="muted">Solo los 4 últimos. Nunca el número completo, CVV, PIN ni claves. Con el vencimiento te avisamos antes de que caduque.</small>
        <button type="button" className="wide" disabled={!ready} onClick={() => setStep(2)}>Continuar</button>
      </div>
      <div className="stack" hidden={step !== 2}>
        {kind === 'credit' ? (
          <>
            <label className="stack-sm"><span>Moneda</span>
              <select name="currency" value={currency} onChange={(e) => setCurrency(e.target.value as 'PEN' | 'USD')}>
                <option value="PEN">Soles (S/)</option><option value="USD">Dólares (US$)</option></select></label>
            <div className="field-row">
              <label className="stack-sm"><span>Línea de la tarjeta</span><span className="money-input"><span className="cur" aria-hidden="true">{currency === 'USD' ? 'US$' : 'S/'}</span>
                <input name="limit" inputMode="decimal" placeholder="10000" /></span></label>
              <label className="stack-sm"><span>Línea usada hoy</span><span className="money-input"><span className="cur" aria-hidden="true">{currency === 'USD' ? 'US$' : 'S/'}</span>
                <input name="used" inputMode="decimal" placeholder="1200" /></span></label>
            </div>
            <small className="muted">Lo usado hoy lo ves en la app de tu banco. Desde aquí, cada compra con esta tarjeta lo actualiza sola.</small>
            <div className="field-row">
              <label className="stack-sm"><span>Día de corte</span><input name="statementDay" inputMode="numeric" maxLength={2} placeholder="20" /></label>
              <label className="stack-sm"><span>Día de pago</span><input name="paymentDay" inputMode="numeric" maxLength={2} placeholder="5" /></label>
            </div>
            <small className="muted">La línea no es dinero disponible: no se suma a tu liquidez.</small>
          </>
        ) : (
          <>
            <p className="muted small">Agrega las cuentas de esta tarjeta y su saldo de hoy. Tu liquidez sale de aquí.</p>
            {Array.from({ length: rows }, (_, i) => (
              <fieldset key={i} className="bare stack-sm account-row">
                <legend>Cuenta {rows > 1 ? i + 1 : ''}</legend>
                <label className="stack-sm"><span>Nombre de la cuenta</span><input name={`account${i}_alias`} maxLength={60} placeholder={i === 0 ? 'Ahorros Soles' : 'Cuenta dólares'} required={i === 0} /></label>
                <div className="field-row">
                  <label className="stack-sm"><span>Moneda</span>
                    <select name={`account${i}_currency`} defaultValue={i === 0 ? 'PEN' : 'USD'} onChange={i === 0 ? (e) => setFirstCurrency(e.target.value as 'PEN' | 'USD') : undefined}>
                      <option value="PEN">Soles (S/)</option><option value="USD">Dólares (US$)</option></select></label>
                  <label className="stack-sm"><span>Saldo actual</span><input name={`account${i}_balance`} inputMode="decimal" placeholder="1500" /></label>
                </div>
              </fieldset>
            ))}
            {rows < MAX_ACCOUNTS && <button type="button" className="quiet" onClick={() => setRows((r) => r + 1)}>+ Agregar otra cuenta</button>}
            <small className="muted">Si no sabes un saldo, déjalo vacío y lo completas después.</small>
          </>
        )}
        <div className="row"><button type="button" className="link" onClick={() => setStep(1)}>Atrás</button><button type="submit">Agregar tarjeta</button></div>
      </div>
    </div>
  );
}

/** "Agregar cuenta a tarjeta" on an existing debit card: same account rows, one or more. */
export function CardAccountsFields({ cardId }: { cardId: string }) {
  const [rows, setRows] = useState(1);
  return (
    <div className="stack">
      <input type="hidden" name="cardId" value={cardId} />
      {Array.from({ length: rows }, (_, i) => (
        <fieldset key={i} className="bare stack-sm account-row">
          <legend>Cuenta {rows > 1 ? i + 1 : ''}</legend>
          <label className="stack-sm"><span>Nombre de la cuenta</span><input name={`account${i}_alias`} maxLength={60} placeholder="Ahorros Soles" required={i === 0} /></label>
          <div className="field-row">
            <label className="stack-sm"><span>Moneda</span><select name={`account${i}_currency`} defaultValue="PEN"><option value="PEN">Soles (S/)</option><option value="USD">Dólares (US$)</option></select></label>
            <label className="stack-sm"><span>Saldo actual</span><input name={`account${i}_balance`} inputMode="decimal" placeholder="1500" /></label>
          </div>
        </fieldset>
      ))}
      {rows < MAX_ACCOUNTS && <button type="button" className="quiet" onClick={() => setRows((r) => r + 1)}>+ Agregar otra cuenta</button>}
      <button type="submit" className="wide">Guardar</button>
    </div>
  );
}
