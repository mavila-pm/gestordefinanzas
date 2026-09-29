/**
 * Names are presentation only (never identity or authorization). People keep their full given and family names;
 * Velsuno talks to them by a short preferred name, by default the first given name. Never derived from the email.
 */
export interface ProfileNames { givenNames: string | null; familyNames: string | null; displayName: string | null }

const clean = (v: unknown): string => (typeof v === 'string' ? v.normalize('NFC').trim().replace(/\s+/g, ' ') : '');
const valid = (s: string, max: number) => s.length <= max && !/[\u0000-\u001f\u007f<>]/.test(s);

export function firstGivenName(given: string | null | undefined): string | null {
  const first = clean(given).split(' ')[0];
  return first ? first : null;
}

/** The name to greet with, or null for a neutral greeting. */
export function preferredName(p: Partial<ProfileNames> | null | undefined): string | null {
  return clean(p?.displayName) || firstGivenName(p?.givenNames) || null;
}

/** "Mauro Ávila": preferred name + first family name, for the profile summary. */
export function shortFullName(p: Partial<ProfileNames> | null | undefined): string | null {
  const name = preferredName(p);
  const family = clean(p?.familyNames).split(' ')[0];
  return name ? [name, family].filter(Boolean).join(' ') : null;
}

export function parseProfileForm(get: (k: string) => unknown):
  { ok: true; value: ProfileNames } | { ok: false; error: string } {
  const givenNames = clean(get('givenNames'));
  const familyNames = clean(get('familyNames'));
  const typed = clean(get('displayName'));
  if (!valid(givenNames, 80) || !valid(familyNames, 80)) return { ok: false, error: 'Revisa tus nombres: hasta 80 caracteres, sin símbolos especiales.' };
  if (!valid(typed, 40)) return { ok: false, error: 'El nombre que usamos contigo puede tener hasta 40 caracteres.' };
  return { ok: true, value: {
    givenNames: givenNames || null,
    familyNames: familyNames || null,
    // Left blank: use the first given name (the person can change it any time).
    displayName: typed || firstGivenName(givenNames),
  } };
}
