'use client';

import { useActionState, useId, useState } from 'react';
import { signup, type FormState } from '../app/auth/actions';

/** Registration step 1: only the email. After sending, the same place says what to do next (no new page load). */
export function SignupForm() {
  const [state, formAction, pending] = useActionState(signup, {} as FormState);
  const [email, setEmail] = useState('');
  const [again, setAgain] = useState(false);
  const id = useId();
  if (state.sent && !again) {
    return (
      <div className="stack-sm sent" role="status" data-testid="signup-sent">
        <h2>Revisa tu correo</h2>
        <p>Te enviamos un enlace a <strong>{email}</strong> para continuar.</p>
        <p className="muted">El enlace vence por seguridad. Si no lo ves, revisa spam o promociones.</p>
        <button type="button" className="link" onClick={() => setAgain(true)}>Usar otro correo</button>
      </div>
    );
  }
  return (
    <form action={(f) => { setAgain(false); return formAction(f); }} className="stack-sm auth-form" aria-busy={pending}>
      <div className="stack-sm field">
        <label htmlFor={`${id}-email`}>Correo electrónico</label>
        <input id={`${id}-email`} name="email" type="email" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false}
          required value={email} onChange={(e) => setEmail(e.target.value)}
          aria-invalid={state.error ? true : undefined} aria-describedby={state.error ? `${id}-error` : undefined} />
      </div>
      {state.error && <p role="alert" className="error" id={`${id}-error`}>{state.error}</p>}
      <button type="submit" disabled={pending} className="wide">{pending ? 'Enviando…' : 'Continuar'}</button>
    </form>
  );
}
