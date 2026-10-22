/**
 * Velsuno's own illustration of a card or account: alias, bank, type, currency and the last 4 digits only — never a
 * full number, expiry, CVV or any credential, and no bank or network logos (no suggestion of issuance or sponsorship).
 * Tone by type: credit = Grafito, debit = Marfil, account = Cítrico. Decorative text is repeated for screen readers.
 */
const BANK: Record<string, string> = { BCP: 'BCP', BBVA: 'BBVA', INTERBANK: 'Interbank' };

export function CardVisual({ alias, institution, kind, currency, last4, size = 'md', selected = false }: {
  alias: string; institution: string | null; kind: 'credit' | 'debit' | 'account'; currency: 'PEN' | 'USD'; last4: string | null; size?: 'sm' | 'md' | 'lg'; selected?: boolean;
}) {
  const type = kind === 'credit' ? 'Crédito' : kind === 'debit' ? 'Débito' : 'Cuenta';
  return (
    <span className={`card-visual ${size}${selected ? ' selected' : ''}`} data-tone={kind} role="img"
      aria-label={`${alias}, ${type}${institution ? `, ${BANK[institution] ?? institution}` : ''}, ${currency === 'USD' ? 'dólares' : 'soles'}${last4 ? `, termina en ${last4}` : ''}`}>
      <span className="cv-top" aria-hidden="true"><span className="cv-bank">{institution ? BANK[institution] ?? institution : 'Otro banco'}</span><span className="cv-type">{type}</span></span>
      <span className="cv-chip" aria-hidden="true" />
      <span className="cv-digits" aria-hidden="true">•••• {last4 ?? '····'}</span>
      <span className="cv-bottom" aria-hidden="true"><span className="cv-alias">{alias || 'Tu tarjeta'}</span><span className="cv-cur">{currency === 'USD' ? 'US$' : 'S/'}</span></span>
    </span>
  );
}
