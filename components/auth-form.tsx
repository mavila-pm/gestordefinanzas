'use client';

import { useActionState, useId, useState } from 'react';
import type { FormState } from '../app/auth/actions';
import { PasswordInput } from './password-input';

interface Field { name: string; label: string; type: string; autoComplete: string; hint?: string; minLength?: number }

export function AuthForm(props: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  fields: Field[];
  submit: string;
  hidden?: Record<string, string>;
}) {
  const [state, formAction, pending] = useActionState(props.action, {});
  // Controlled: React resets a form after its action; what the person typed must survive an error.
  const [values, setValues] = useState<Record<string, string>>({});
  const set = (name: string) => (v: string) => setValues((x) => ({ ...x, [name]: v }));
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <form action={formAction} className="stack-sm auth-form" aria-busy={pending}>
      {Object.entries(props.hidden ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {props.fields.map((f) => {
        const fid = `${id}-${f.name}`;
        const describedBy = [state.error ? errorId : '', f.hint ? `${fid}-hint` : ''].filter(Boolean).join(' ') || undefined;
        return (
          <div key={f.name} className="stack-sm field">
            <label htmlFor={fid}>{f.label}</label>
            {f.type === 'password'
              ? <PasswordInput id={fid} name={f.name} autoComplete={f.autoComplete as 'current-password' | 'new-password'} describedBy={describedBy} invalid={!!state.error}
                  value={values[f.name] ?? ''} onChange={set(f.name)} />
              : <input id={fid} name={f.name} type={f.type} autoComplete={f.autoComplete} required minLength={f.minLength}
                  value={values[f.name] ?? ''} onChange={(e) => set(f.name)(e.target.value)}
                  inputMode={f.type === 'email' ? 'email' : undefined} autoCapitalize={f.type === 'email' ? 'none' : undefined} spellCheck={false}
                  aria-invalid={state.error ? true : undefined} aria-describedby={describedBy} />}
            {f.hint && <small className="muted" id={`${fid}-hint`}>{f.hint}</small>}
          </div>
        );
      })}
      {state.error && <p role="alert" className="error" id={errorId}>{state.error}</p>}
      {state.message && <p role="status" className="notice positive">{state.message}</p>}
      <button type="submit" disabled={pending} className="wide">{pending ? 'Un momento…' : props.submit}</button>
    </form>
  );
}
