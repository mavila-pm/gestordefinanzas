'use client';

import { useActionState, useEffect, useId, useMemo, useRef, useState } from 'react';
import { checkSplit, MAX_PARTS, NOTE_MAX, SPLIT_ERROR_TEXT } from '../src/domain/allocations';
import { formatMoney, parseAmountToMinor, type Currency } from '../src/domain/money';
import type { ActionState } from '../app/app/actions';
import { Icon } from './ui/icon';
import { useSheet } from './ui/sheet';

interface Part { key: number; categoryId: string; amount: string; note: string }
const toInput = (minor: number) => `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;

/**
 * Split editor (inside a Sheet). Rows of category + amount (+ optional note), a live summary
 * (movimiento / asignado / restante) and one action. Values stay in React state, so a failed save keeps them.
 */
export function SplitEditor(props: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  txId: string;
  version: string;
  amountMinor: number;
  currency: Currency;
  ownCategory: string;
  categories: Array<{ id: string; name: string }>;
  initial: Array<{ categoryId: string; amountMinor: number; note: string | null }>;
}) {
  const sheet = useSheet();
  const uid = useId();
  const nextKey = useRef(props.initial.length + 2);
  const fresh = (): Part => ({ key: nextKey.current++, categoryId: '', amount: '', note: '' });
  const [parts, setParts] = useState<Part[]>(() => props.initial.length
    ? props.initial.map((p, i) => ({ key: i, categoryId: p.categoryId, amount: toInput(p.amountMinor), note: p.note ?? '' }))
    : [fresh(), fresh()]);
  const [state, formAction, pending] = useActionState(props.action, {});
  const lastState = useRef(state);
  useEffect(() => {
    if (state !== lastState.current && state.message && !state.error) sheet.close();
    lastState.current = state;
  }, [state, sheet]);

  const parsed = parts.map((p) => ({ categoryId: p.categoryId || null, amountMinor: p.amount.trim() ? parseAmountToMinor(p.amount) : null, note: p.note.trim() || null }));
  const check = checkSplit(props.amountMinor, parsed);
  const m = (v: number) => formatMoney({ amountMinor: Math.abs(v), currency: props.currency });
  const payload = useMemo(() => JSON.stringify(parsed.map((p) => ({ categoryId: p.categoryId, amountMinor: p.amountMinor, note: p.note }))), [parsed]);
  const update = (key: number, patch: Partial<Part>) => setParts((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const symbol = props.currency === 'PEN' ? 'S/' : 'US$';
  const statusId = `${uid}-status`;

  return (
    <form action={formAction} aria-label="Dividir gasto" style={{ display: 'contents' }}>
      <input type="hidden" name="id" value={props.txId} />
      <input type="hidden" name="version" value={props.version} />
      <input type="hidden" name="parts" value={payload} />
      <div className="sheet-body">
        <ul className="split-rows" aria-label="Partes">
          {parts.map((p, i) => (
            <li key={p.key} className="split-row" data-testid="split-row">
              <label className="stack-sm">
                <span className={i === 0 ? '' : 'sr-only'}>Categoría</span>
                <select value={p.categoryId} onChange={(e) => update(p.key, { categoryId: e.target.value })} aria-label={`Categoría de la parte ${i + 1}`}>
                  <option value="">Elige</option>
                  {props.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <label className="stack-sm">
                <span className={i === 0 ? '' : 'sr-only'}>Importe</span>
                <span className="money-input">
                  <span className="cur" aria-hidden="true">{symbol}</span>
                  <input value={p.amount} onChange={(e) => update(p.key, { amount: e.target.value })} inputMode="decimal" autoComplete="off"
                    aria-label={`Importe de la parte ${i + 1} en ${props.currency === 'PEN' ? 'soles' : 'dólares'}`} placeholder="0.00" />
                </span>
              </label>
              <button type="button" className="icon" onClick={() => setParts((ps) => ps.filter((x) => x.key !== p.key))}
                aria-label={`Quitar la parte ${i + 1}`} disabled={parts.length === 1}><Icon name="trash" /></button>
              <input className="note" value={p.note} onChange={(e) => update(p.key, { note: e.target.value })} maxLength={NOTE_MAX}
                placeholder="Nota (opcional)" aria-label={`Nota de la parte ${i + 1}`} style={{ gridColumn: '1 / 3', minHeight: 40, padding: '8px 12px' }} />
            </li>
          ))}
        </ul>
        {parts.length < MAX_PARTS && (
          <button type="button" className="quiet" style={{ marginTop: 12 }} onClick={() => setParts((ps) => [...ps, fresh()])}>
            <Icon name="add" size={18} />Añadir parte
          </button>
        )}
      </div>
      <div className="sheet-foot">
        <div className="summary" aria-live="polite" id={statusId}>
          <div><span className="muted">Movimiento</span><span>{m(props.amountMinor)}</span></div>
          <div><span className="muted">Asignado</span><span data-testid="split-allocated">{m(check.allocatedMinor)}</span></div>
          <div className={`remaining${check.remainingMinor < 0 ? ' over' : ''}`}>
            <span>{check.remainingMinor < 0 ? 'Te pasaste por' : 'Restante'}</span>
            <span data-testid="split-remaining">{m(check.remainingMinor)}</span>
          </div>
          {check.remainingMinor > 0 && !check.error && <small className="muted">Lo restante se queda en {props.ownCategory}.</small>}
          {check.error && <small className="warn" data-testid="split-hint">{SPLIT_ERROR_TEXT[check.error]}</small>}
        </div>
        {state.error && <p role="alert" className="notice error">{state.error}</p>}
        <button type="submit" className="wide" disabled={!!check.error || pending} aria-describedby={statusId}>
          {pending ? 'Guardando…' : 'Guardar división'}
        </button>
        {props.initial.length > 0 && (
          <button type="submit" className="link" name="clear" value="1" disabled={pending} style={{ justifySelf: 'center' }}>Quitar división</button>
        )}
      </div>
    </form>
  );
}
