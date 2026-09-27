'use client';

import { useActionState } from 'react';
import type { FormState } from '../app/auth/actions';

interface Field { name: string; label: string; type: string; autoComplete: string }

export function AuthForm(props: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  fields: Field[];
  submit: string;
  hidden?: Record<string, string>;
}) {
  const [state, formAction, pending] = useActionState(props.action, {});
  return (
    <form action={formAction} className="card stack">
      {Object.entries(props.hidden ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {props.fields.map((f) => (
        <label key={f.name} className="stack-sm">
          <span>{f.label}</span>
          <input name={f.name} type={f.type} autoComplete={f.autoComplete} required />
        </label>
      ))}
      {state.error && <p role="alert" className="error">{state.error}</p>}
      {state.message && <p role="status" className="ok">{state.message}</p>}
      <button type="submit" disabled={pending}>{pending ? 'Procesando…' : props.submit}</button>
    </form>
  );
}
