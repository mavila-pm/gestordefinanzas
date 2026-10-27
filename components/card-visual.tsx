/**
 * Velsuno's own illustration of a card or account: alias, bank, type, currency, the last 4 digits and the expiry
 * MM/AA when registered (CR-001) — never a full number, CVV or any credential, and no bank or network logos (no
 * suggestion of issuance or sponsorship). Colour: the one the person chose (brand tokens per `data-color`), otherwise
 * the tone by type: credit = Grafito, debit = Marfil, account = Cítrico. Decorative text is repeated for screen readers.
 */
import { BANK_LABEL } from '../src/web/money-source-input';

export function CardVisual({ alias, institution, bankName = null, kind, currency, last4, color = null, expiry = null, size = 'md', selected = false }: {
  alias: string; institution: string | null; bankName?: string | null; kind: 'credit' | 'debit' | 'account'; currency: 'PEN' | 'USD'; last4: string | null;
  color?: string | null; expiry?: string | null; size?: 'sm' | 'md' | 'lg'; selected?: boolean;
}) {
  const type = kind === 'credit' ? 'Crédito' : kind === 'debit' ? 'Débito' : 'Cuenta';
  const bank = institution ? BANK_LABEL[institution] ?? institution : bankName?.trim() || 'Otro banco';
  return (
    <span className={`card-visual ${size}${selected ? ' selected' : ''}`} data-tone={kind} data-color={color ?? undefined} role="img"
      aria-label={`${alias}, ${type}, ${bank}, ${currency === 'USD' ? 'dólares' : 'soles'}${last4 ? `, termina en ${last4}` : ''}${expiry ? `, vence ${expiry}` : ''}`}>
      <span className="cv-top" aria-hidden="true"><span className="cv-bank">{bank}</span><span className="cv-type">{type}</span></span>
      <span className="cv-chip" aria-hidden="true" />
      <span className="cv-digits" aria-hidden="true">•••• {last4 ?? '····'}{expiry && <span className="cv-exp">{expiry}</span>}</span>
      <span className="cv-bottom" aria-hidden="true"><span className="cv-alias">{alias || 'Tu tarjeta'}</span><span className="cv-cur">{currency === 'USD' ? 'US$' : 'S/'}</span></span>
    </span>
  );
}
