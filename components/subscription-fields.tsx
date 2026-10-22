'use client';

import { useMemo, useState } from 'react';
import { formatMoney, parseAmountToMinor } from '../src/domain/money';
import { providerBySlug, searchProviders } from '../src/domain/subscriptions';
import { SubLogo } from './sub-logo';

export interface SubscriptionInitial {
  id?: string; provider: string | null; name: string; amount: string; currency: 'PEN' | 'USD'; frequency: 'monthly' | 'quarterly' | 'yearly'; nextDate: string; instrument: string;
}
const FREQ = { monthly: 'Mensual', quarterly: 'Trimestral', yearly: 'Anual' } as const;

/**
 * Add / edit a subscription in one short form: pick the service (search the catalogue or type your own), its price
 * (or leave it for later: "por confirmar"), how often and the next charge. A live preview shows how it will look.
 * Fields only — the parent ActionForm posts them; the server parses and validates everything again.
 */
export function SubscriptionFields({ initial, instruments, today }: { initial: SubscriptionInitial; instruments: Array<{ value: string; label: string }>; today: string }) {
  const [provider, setProvider] = useState<string | null>(initial.provider);
  const [name, setName] = useState(initial.name);
  const [query, setQuery] = useState('');
  const [amount, setAmount] = useState(initial.amount);
  const [currency, setCurrency] = useState(initial.currency);
  const [frequency, setFrequency] = useState(initial.frequency);
  const [nextDate, setNextDate] = useState(initial.nextDate);
  const results = useMemo(() => searchProviders(query).slice(0, query ? 8 : 12), [query]);
  const minor = amount ? parseAmountToMinor(amount) : null;
  const shownName = name || providerBySlug(provider)?.name || 'Tu suscripción';
  const pick = (slug: string) => { const p = providerBySlug(slug)!; setProvider(p.slug); setName(p.name); setQuery(''); };

  return (
    <div className="stack">
      {initial.id && <input type="hidden" name="id" value={initial.id} />}
      <input type="hidden" name="provider" value={provider ?? ''} />

      <div className="sub-preview" aria-live="polite" data-testid="sub-preview">
        <SubLogo provider={provider} name={shownName} size={44} />
        <span className="setting-text"><strong>{shownName}</strong>
          <small className="muted">{FREQ[frequency]}{nextDate ? ` · próximo cobro ${nextDate.split('-').reverse().join('/')}` : ''}</small></span>
        <strong className={`amount${minor === null ? ' unknown' : ''}`}>{minor === null ? 'Por confirmar' : formatMoney({ amountMinor: minor, currency })}</strong>
      </div>

      {!initial.id && (
        <div className="stack-sm">
          <label className="stack-sm"><span>Servicio</span>
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Busca Netflix, Spotify, Disney+…" autoComplete="off" aria-controls="sub-catalog" /></label>
          <ul className="plain sub-catalog" id="sub-catalog" aria-label="Servicios conocidos">
            {results.map((p) => (
              <li key={p.slug}>
                <button type="button" className={`sub-option${provider === p.slug ? ' selected' : ''}`} aria-pressed={provider === p.slug} onClick={() => pick(p.slug)}>
                  <SubLogo provider={p.slug} name={p.name} size={32} /><span>{p.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <label className="stack-sm"><span>{provider ? 'Nombre (puedes cambiarlo)' : 'O escribe el nombre'}</span>
        <input name="name" value={name} onChange={(e) => { setName(e.target.value); if (!e.target.value) setProvider(null); }} maxLength={60} placeholder="Ej. Gimnasio" required /></label>

      <div className="field-row">
        <label className="stack-sm"><span>Precio</span>
          <span className="money-input"><span className="cur" aria-hidden="true">{currency === 'USD' ? 'US$' : 'S/'}</span>
            <input name="amount" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="44.90" /></span>
          <small className="muted">Si no lo sabes aún, déjalo vacío.</small></label>
        <label className="stack-sm"><span>Moneda</span>
          <select name="currency" value={currency} onChange={(e) => setCurrency(e.target.value as 'PEN' | 'USD')}>
            <option value="PEN">Soles (S/)</option><option value="USD">Dólares (US$)</option></select></label>
      </div>

      <fieldset className="segmented bare"><legend>Se cobra</legend>
        <div className="segments" role="radiogroup">
          {(Object.keys(FREQ) as Array<keyof typeof FREQ>).map((f) => (
            <label key={f} className="segment"><input type="radio" name="frequency" value={f} checked={frequency === f} onChange={() => setFrequency(f)} /><span>{FREQ[f]}</span></label>
          ))}
        </div>
      </fieldset>

      <div className="field-row">
        <label className="stack-sm"><span>Próximo cobro</span>
          <input type="date" name="nextDate" value={nextDate} min={today} onChange={(e) => setNextDate(e.target.value)} required />
          <small className="muted">Si el día no existe en un mes (29–31), se cobra el último día.</small></label>
        <label className="stack-sm"><span>Se paga con</span>
          <select name="instrument" defaultValue={initial.instrument}>
            <option value="">Sin indicar</option>
            {instruments.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
          </select></label>
      </div>
      <button type="submit" className="wide">{initial.id ? 'Guardar cambios' : 'Añadir suscripción'}</button>
    </div>
  );
}
