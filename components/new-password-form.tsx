'use client';

import { useActionState, useId, useState } from 'react';
import { createPassword, type FormState } from '../app/auth/actions';
import { PASSWORD_HINT, PASSWORD_MIN } from '../src/web/auth-input';
import { PasswordInput } from './password-input';

/** Registration step 2. The checklist follows what is typed (quietly); the server validates again. */
export function NewPasswordForm() {
  const [state, formAction, pending] = useActionState(createPassword, {} as FormState);
  const [value, setValue] = useState('');
  const id = useId();
  const rules = [
    { ok: value.length >= PASSWORD_MIN, text: `${PASSWORD_MIN} caracteres o más` },
    { ok: /\p{L}/u.test(value), text: 'Letras' },
    { ok: /\p{N}/u.test(value), text: 'Números' },
  ];
  return (
    <form action={formAction} className="stack-sm auth-form" aria-busy={pending}>
      <div className="stack-sm field">
        <label htmlFor={`${id}-pw`}>Contraseña</label>
        <PasswordInput id={`${id}-pw`} name="password" autoComplete="new-password" autoFocus value={value} onChange={setValue}
          describedBy={[`${id}-hint`, state.error ? `${id}-error` : ''].filter(Boolean).join(' ')} invalid={!!state.error} />
        <small className="muted" id={`${id}-hint`}>{PASSWORD_HINT}</small>
        <ul className="pw-rules" aria-hidden="true">
          {rules.map((r) => <li key={r.text} data-ok={r.ok}>{r.text}</li>)}
        </ul>
      </div>
      {state.error && <p role="alert" className="error" id={`${id}-error`}>{state.error}</p>}
      <button type="submit" disabled={pending} className="wide">{pending ? 'Guardando…' : 'Continuar'}</button>
    </form>
  );
}
