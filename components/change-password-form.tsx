'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { changePassword } from '../app/auth/actions';
import { passwordProblem, PASSWORD_HINT, PASSWORD_MIN } from '../src/web/auth-input';
import { submitGate, type ChangePasswordState } from '../src/web/password-change';
import { PasswordInput } from './password-input';

/** Ajustes → Cambiar contraseña. Checks as you type and before sending; the server validates again. */
export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState(changePassword, {} as ChangePasswordState);
  const [value, setValue] = useState('');
  const [code, setCode] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const gate = useRef(submitGate());
  const id = useId();

  // The answer arrived: open the gate; after a change, clear what was typed.
  useEffect(() => { if (!pending) gate.current.leave(); }, [pending, state]);
  useEffect(() => { if (state.done) { setValue(''); setCode(''); } }, [state.done]);

  const rules = [
    { ok: value.length >= PASSWORD_MIN, text: `${PASSWORD_MIN} caracteres o más` },
    { ok: /\p{L}/u.test(value), text: 'Letras' },
    { ok: /\p{N}/u.test(value), text: 'Números' },
  ];
  const error = localError ?? state.error;
  const busy = pending || gate.current.busy;

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    const problem = passwordProblem(value);
    if (problem) { e.preventDefault(); setLocalError(problem); return; }
    if (!gate.current.enter()) { e.preventDefault(); return; }
    setLocalError(null);
  }

  return (
    <form action={formAction} onSubmit={onSubmit} className="stack-sm" aria-busy={busy} data-testid="change-password-form" noValidate>
      <div className="stack-sm field">
        <label htmlFor={`${id}-pw`}>Contraseña nueva</label>
        <PasswordInput id={`${id}-pw`} name="password" autoComplete="new-password" value={value}
          onChange={(v) => { setValue(v); setLocalError(null); }}
          describedBy={[`${id}-hint`, error ? `${id}-error` : ''].filter(Boolean).join(' ')} invalid={!!error} />
        <small className="muted" id={`${id}-hint`}>{PASSWORD_HINT}</small>
        <ul className="pw-rules" aria-hidden="true">
          {rules.map((r) => <li key={r.text} data-ok={r.ok}>{r.text}</li>)}
        </ul>
      </div>
      {state.needsCode && (
        <div className="stack-sm field">
          <label htmlFor={`${id}-code`}>Código del correo</label>
          <input id={`${id}-code`} name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={12} required
            value={code} onChange={(e) => setCode(e.target.value)} aria-invalid={error ? true : undefined} />
        </div>
      )}
      {error && <p role="alert" className="error" id={`${id}-error`}>{error}</p>}
      {!error && state.message && <p role="status" className="notice positive" data-testid="change-password-status">{state.message}</p>}
      <button type="submit" disabled={busy} className="wide">{busy ? 'Guardando…' : 'Cambiar contraseña'}</button>
    </form>
  );
}
