'use client';

import { useActionState, useEffect, useId, useState } from 'react';
import { signup, type FormState } from '../app/auth/actions';
import { CapField } from './cap-field';

/** Wait before another link can be requested (Supabase Auth also refuses faster resends server-side). */
const RESEND_SECONDS = 60;

/** Registration step 1: only the email. After sending, the same place says what to do next (no new page load). */
export function SignupForm() {
  const [state, formAction, pending] = useActionState(signup, {} as FormState);
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const id = useId();

  // Every successful send (first or resend) starts the countdown again.
  useEffect(() => {
    if (state.sent) { setSentTo(email); setWait(RESEND_SECONDS); }
  }, [state]);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  if (sentTo) {
    return (
      <form action={formAction} className="stack-sm sent" data-testid="signup-sent" aria-busy={pending}>
        <input type="hidden" name="email" value={sentTo} />
        <div role="status" className="stack-sm">
          <h2>Revisa tu correo</h2>
          <p>Te enviamos un enlace a <strong>{sentTo}</strong> para continuar.</p>
        </div>
        <p className="muted">El enlace vence por seguridad. Si no lo ves, revisa spam o promociones.</p>
        <CapField scope="signup" resetKey={state} />
        {state.error && <p role="alert" className="error">{state.error}</p>}
        <button type="submit" className="secondary wide" disabled={pending || wait > 0} data-testid="signup-resend">
          {pending ? 'Enviando…' : wait > 0 ? `Reenviar enlace en ${wait} s` : 'Reenviar enlace'}
        </button>
        <button type="button" className="link" onClick={() => { setSentTo(null); setWait(0); }}>Usar otro correo</button>
      </form>
    );
  }
  return (
    <form action={formAction} className="stack-sm auth-form" aria-busy={pending}>
      <div className="stack-sm field">
        <label htmlFor={`${id}-email`}>Correo electrónico</label>
        <input id={`${id}-email`} name="email" type="email" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false}
          required value={email} onChange={(e) => setEmail(e.target.value)}
          aria-invalid={state.error ? true : undefined} aria-describedby={state.error ? `${id}-error` : undefined} />
      </div>
      <CapField scope="signup" resetKey={state.error ? state : undefined} />
      {state.error && <p role="alert" className="error" id={`${id}-error`}>{state.error}</p>}
      <button type="submit" disabled={pending} className="wide">{pending ? 'Enviando…' : 'Continuar'}</button>
    </form>
  );
}
