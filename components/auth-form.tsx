'use client';

import { useActionState, useId } from 'react';
import type { FormState } from '../app/auth/actions';

interface Field { name: string; label: string; type: string; autoComplete: string; hint?: string; minLength?: number }

export function AuthForm(props: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  fields: Field[];
  submit: string;
  hidden?: Record<string, string>;
}) {
  const [state, formAction, pending] = useActionState(props.action, {});
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <form action={formAction} className="stack-sm" style={{ gap: 16 }} aria-busy={pending} noValidate={false}>
      {Object.entries(props.hidden ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {props.fields.map((f) => (
        <label key={f.name} className="stack-sm">
          <span>{f.label}</span>
          <input name={f.name} type={f.type} autoComplete={f.autoComplete} required minLength={f.minLength}
            inputMode={f.type === 'email' ? 'email' : undefined} autoCapitalize={f.type === 'email' ? 'none' : undefined} spellCheck={false}
            aria-invalid={state.error ? true : undefined} aria-describedby={[state.error ? errorId : '', f.hint ? `${id}-${f.name}-hint` : ''].filter(Boolean).join(' ') || undefined} />
          {f.hint && <small className="muted" id={`${id}-${f.name}-hint`}>{f.hint}</small>}
        </label>
      ))}
      {state.error && <p role="alert" className="error" id={errorId}>{state.error}</p>}
      {state.message && <p role="status" className="notice positive">{state.message}</p>}
      <button type="submit" disabled={pending} className="wide">{pending ? 'Un momento…' : props.submit}</button>
    </form>
  );
}
