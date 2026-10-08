'use client';

import Link from 'next/link';
import { useActionState, useId, useState } from 'react';
import { completeProfile, type FormState } from '../app/auth/actions';

/**
 * Registration step 3: only what Velsuno needs. The verified email is shown, not asked again. Age 18+ is decided
 * from the birth date on the server (the date picker's max is only a convenience). Consent is never pre-checked.
 */
export function ProfileForm({ email, maxBirthDate }: { email: string; maxBirthDate: string }) {
  const [state, formAction, pending] = useActionState(completeProfile, {} as FormState);
  // Controlled: React resets a form after its action; an error must not erase what the person typed.
  const [v, setV] = useState({ givenNames: '', familyNames: '', phone: '+51 ', birthDate: '', accept: false });
  const bind = (k: 'givenNames' | 'familyNames' | 'phone' | 'birthDate') => ({ name: k, value: v[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setV((x) => ({ ...x, [k]: e.target.value })) });
  const id = useId();
  const err = state.error ? `${id}-error` : undefined;
  return (
    <form action={formAction} className="stack-sm auth-form" aria-busy={pending}>
      <div className="field-row">
        <div className="stack-sm field">
          <label htmlFor={`${id}-given`}>Nombre</label>
          <input id={`${id}-given`} {...bind('givenNames')} autoComplete="given-name" required maxLength={80} aria-describedby={err} />
        </div>
        <div className="stack-sm field">
          <label htmlFor={`${id}-family`}>Apellidos</label>
          <input id={`${id}-family`} {...bind('familyNames')} autoComplete="family-name" required maxLength={80} aria-describedby={err} />
        </div>
      </div>
      <div className="stack-sm field">
        <label htmlFor={`${id}-email`}>Correo electrónico</label>
        <input id={`${id}-email`} type="email" value={email} readOnly aria-readonly="true" className="readonly" data-testid="profile-email" />
      </div>
      <div className="stack-sm field">
        <label htmlFor={`${id}-phone`}>Número de celular</label>
        <input id={`${id}-phone`} {...bind('phone')} type="tel" inputMode="tel" autoComplete="tel" required placeholder="+51 987 654 321"
          aria-describedby={[`${id}-phone-hint`, err].filter(Boolean).join(' ')} />
        <small className="muted" id={`${id}-phone-hint`}>Si no es de Perú, cambia el código de país.</small>
      </div>
      <div className="stack-sm field">
        <label htmlFor={`${id}-birth`}>Fecha de nacimiento</label>
        <input id={`${id}-birth`} {...bind('birthDate')} type="date" required min="1900-01-01" max={maxBirthDate} autoComplete="bday"
          aria-describedby={[`${id}-birth-hint`, err].filter(Boolean).join(' ')} />
        <small className="muted" id={`${id}-birth-hint`}>Velsuno es para mayores de 18 años.</small>
      </div>
      <label className="consent">
        <input type="checkbox" name="accept" required checked={v.accept} onChange={(e) => setV((x) => ({ ...x, accept: e.target.checked }))} />
        <span>He leído y acepto los <Link href="/terminos" target="_blank" rel="noopener">Términos</Link> y la <Link href="/privacidad" target="_blank" rel="noopener">Política de Privacidad</Link>.</span>
      </label>
      {state.error && <p role="alert" className="error" id={`${id}-error`}>{state.error}</p>}
      <button type="submit" disabled={pending} className="wide">{pending ? 'Creando tu cuenta…' : 'Crear mi cuenta'}</button>
    </form>
  );
}
