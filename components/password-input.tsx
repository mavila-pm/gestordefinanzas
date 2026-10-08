'use client';

import { useState } from 'react';
import { Icon } from './ui/icon';

/**
 * Password field with a show/hide button: keeps the value and the layout, works with the keyboard, 44 px target.
 * The visible state is announced through the button's label ("Mostrar/Ocultar contraseña") and aria-pressed.
 */
export function PasswordInput(props: {
  id: string; name: string; autoComplete: 'current-password' | 'new-password';
  describedBy?: string; invalid?: boolean; value?: string; onChange?: (v: string) => void; autoFocus?: boolean;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="password-field">
      <input id={props.id} name={props.name} type={shown ? 'text' : 'password'} autoComplete={props.autoComplete} required
        autoCapitalize="none" autoCorrect="off" spellCheck={false} autoFocus={props.autoFocus}
        aria-invalid={props.invalid || undefined} aria-describedby={props.describedBy}
        value={props.value} onChange={props.onChange ? (e) => props.onChange!(e.target.value) : undefined} />
      <button type="button" className="icon reveal" aria-controls={props.id} aria-pressed={shown}
        aria-label={shown ? 'Ocultar contraseña' : 'Mostrar contraseña'} onClick={() => setShown((v) => !v)}>
        <Icon name={shown ? 'eyeOff' : 'eye'} size={20} />
      </button>
    </div>
  );
}
