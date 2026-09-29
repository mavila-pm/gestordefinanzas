'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { importAction, type ImportState } from '../app/app/actions';

export function ImportForm() {
  const [state, formAction, pending] = useActionState<ImportState, FormData>(importAction, {});
  return (
    <form action={formAction} className="card stack" aria-label="Importar mensaje" aria-busy={pending}>
      <fieldset disabled={pending} className="bare">
        <label className="stack-sm"><span>Tipo de mensaje</span>
          <select name="channel" defaultValue="sms"><option value="sms">SMS</option><option value="email">Correo</option></select>
        </label>
        <label className="stack-sm"><span>Asunto (solo correos, opcional)</span><input name="subject" maxLength={300} /></label>
        <label className="stack-sm"><span>Texto del mensaje</span>
          <textarea name="text" required rows={8} maxLength={65536} placeholder="BCP: Realizaste un consumo de S/ 45.90 con tu Tarjeta de Credito *4821 en ..." />
        </label>
        <button type="submit">{pending ? 'Leyendo…' : 'Importar'}</button>
      </fieldset>
      {state.error && <p role="alert" className="error" data-outcome={state.outcome}>{state.error}</p>}
      {state.message && (
        <p role="status" className="ok" data-outcome={state.outcome}>
          {state.message}{' '}
          {state.transactionId && <Link href={`/app/movimientos/${state.transactionId}`}>Ver movimiento</Link>}
        </p>
      )}
    </form>
  );
}
