'use client';

import { useState } from 'react';
import { firstGivenName } from '../src/domain/profile';

/** Given names, family names and the name we use: the last one follows the first given name until edited. */
export function ProfileFields({ givenNames, familyNames, displayName }: { givenNames: string; familyNames: string; displayName: string }) {
  const [given, setGiven] = useState(givenNames);
  const [preferred, setPreferred] = useState(displayName);
  const [touched, setTouched] = useState(!!displayName && displayName !== firstGivenName(givenNames));
  return (
    <>
      <label className="stack-sm"><span>Nombres</span>
        <input name="givenNames" value={given} maxLength={80} autoComplete="given-name" autoCapitalize="words"
          onChange={(e) => { setGiven(e.target.value); if (!touched) setPreferred(firstGivenName(e.target.value) ?? ''); }} /></label>
      <label className="stack-sm"><span>Apellidos</span>
        <input name="familyNames" defaultValue={familyNames} maxLength={80} autoComplete="family-name" autoCapitalize="words" /></label>
      <label className="stack-sm"><span>¿Cómo quieres que te llamemos?</span>
        <input name="displayName" value={preferred} maxLength={40} autoComplete="nickname" autoCapitalize="words"
          onChange={(e) => { setPreferred(e.target.value); setTouched(true); }} /></label>
    </>
  );
}
