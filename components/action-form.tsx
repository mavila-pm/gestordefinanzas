'use client';

import { useActionState } from 'react';
import type { ActionState } from '../app/app/actions';

/** Form bound to a server action; shows its error/confirmation. Fields are passed as children. */
export function ActionForm(props: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  children: React.ReactNode;
  className?: string;
  label?: string;
}) {
  const [state, formAction, pending] = useActionState(props.action, {});
  return (
    <form action={formAction} className={props.className ?? 'stack'} aria-label={props.label} aria-busy={pending}>
      <fieldset disabled={pending} className="bare">{props.children}</fieldset>
      {state.error && <p role="alert" className="error">{state.error}</p>}
      {state.message && <p role="status" className="ok">{state.message}</p>}
    </form>
  );
}
