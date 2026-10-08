'use client';

import Link from 'next/link';
import { useActionState, useEffect, useId, useState } from 'react';
import { completeProfile, type FormState } from '../app/auth/actions';
import { birthProblem, limaToday, normalizePhone, PHONE_ERROR } from '../src/web/auth-input';

/**
 * Registration step 3: only what Velsuno needs. The verified email is shown, not asked again. Age 18+ is decided
 * from the birth date on the server (the same rule runs here as the person types). Peru-only phone: fixed +51 and
 * the 9 digits (validated again on the server and in SQL). Consent is never pre-checked.
 */
export function ProfileForm({ email, maxBirthDate }: { email: string; maxBirthDate: string }) {
  const [state, formAction, pending] = useActionState(completeProfile, {} as FormState);
  // Controlled: React resets a form after its action; an error must not erase what the person typed.
  const [v, setV] = useState({ givenNames: '', familyNames: '', phone: '', birthDate: '', accept: false });
  const bind = (k: 'givenNames' | 'familyNames' | 'phone' | 'birthDate') => ({ name: k, value: v[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setV((x) => ({ ...x, [k]: e.target.value })) });
  const id = useId();
  // A server error describes the last submit: once the person edits a field it no longer applies, so it is hidden.
  const [edited, setEdited] = useState(false);
  useEffect(() => { setEdited(false); }, [state]);
  const serverError = edited ? null : state.error;
  const err = serverError ? `${id}-error` : undefined;
  // Checked while typing: the phone once all 9 digits are in (or on leaving the field), the date as soon as it is set.
  const [phoneTouched, setPhoneTouched] = useState(false);
  const phoneError = (phoneTouched || v.phone.length === 9) && !normalizePhone(v.phone) ? PHONE_ERROR : null;
  const birthError = v.birthDate ? birthProblem(v.birthDate, limaToday()) : null;
  return (
    <form action={formAction} className="stack-sm auth-form" aria-busy={pending} onChange={() => setEdited(true)}>
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
        <div className="phone-field">
          <span className="phone-prefix" aria-hidden="true">+51</span>
          <input id={`${id}-phone`} name="phone" value={v.phone} type="tel" inputMode="numeric" autoComplete="tel-national" required
            pattern="9[0-9]{8}" placeholder="987654321"
            onChange={(e) => setV((x) => ({ ...x, phone: e.target.value.replace(/\D/g, '').slice(0, 9) }))} onBlur={() => setPhoneTouched(true)}
            aria-invalid={phoneError ? true : undefined} aria-describedby={[`${id}-phone-msg`, err].filter(Boolean).join(' ')} />
        </div>
        {phoneError ? <small className="error" id={`${id}-phone-msg`} role="alert">{phoneError}</small>
          : <small className="muted" id={`${id}-phone-msg`}>Celular de Perú (+51): escribe los 9 dígitos.</small>}
      </div>
      <div className="stack-sm field">
        <label htmlFor={`${id}-birth`}>Fecha de nacimiento</label>
        <input id={`${id}-birth`} {...bind('birthDate')} type="date" required min="1900-01-01" max={maxBirthDate} autoComplete="bday"
          aria-invalid={birthError ? true : undefined} aria-describedby={[`${id}-birth-msg`, err].filter(Boolean).join(' ')} />
        {birthError ? <small className="error" id={`${id}-birth-msg`} role="alert">{birthError}</small>
          : <small className="muted" id={`${id}-birth-msg`}>Velsuno es para personas mayores de 18 años.</small>}
      </div>
      <label className="consent">
        <input type="checkbox" name="accept" required checked={v.accept} onChange={(e) => setV((x) => ({ ...x, accept: e.target.checked }))} />
        <span>He leído y acepto los <Link href="/terminos" target="_blank" rel="noopener">Términos</Link> y la <Link href="/privacidad" target="_blank" rel="noopener">Política de Privacidad</Link>.</span>
      </label>
      {serverError && <p role="alert" className="error" id={`${id}-error`}>{serverError}</p>}
      <button type="submit" disabled={pending || !!phoneError || !!birthError} className="wide">{pending ? 'Creando tu cuenta…' : 'Crear mi cuenta'}</button>
    </form>
  );
}
