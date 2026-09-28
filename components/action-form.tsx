'use client';

import { useActionState, useEffect, useRef } from 'react';
import type { ActionState } from '../app/app/actions';
import { useSheet } from './ui/sheet';

/**
 * Form bound to a server action; shows its error/confirmation. Fields are passed as children.
 * Inside a Sheet, `closeOnSuccess` closes it when the action succeeds (on error it stays open, inputs kept).
 */
export function ActionForm(props: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  children: React.ReactNode;
  className?: string;
  label?: string;
  closeOnSuccess?: boolean;
}) {
  const [state, formAction, pending] = useActionState(props.action, {});
  const sheet = useSheet();
  const last = useRef(state);
  useEffect(() => {
    if (props.closeOnSuccess && state !== last.current && !state.error) sheet.close();
    last.current = state;
  }, [state, sheet, props.closeOnSuccess]);
  return (
    <form action={formAction} className={props.className ?? 'stack'} aria-label={props.label} aria-busy={pending}>
      <fieldset disabled={pending} className="bare">{props.children}</fieldset>
      {state.error && <p role="alert" className="error">{state.error}</p>}
      {state.message && !props.closeOnSuccess && <p role="status" className="ok">{state.message}</p>}
    </form>
  );
}
