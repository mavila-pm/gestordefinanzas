import type { Currency } from '../domain/money';
import type { ObligationKind } from '../engine/planning';

/**
 * Structured facts learned in conversation (ADR-0006). The draft IS the memory of the onboarding: the transcript is
 * only what the person sees. Unknown stays unknown (never 0); approximate values are 'estimated'.
 */
export type FactStatus = 'confirmed' | 'estimated' | 'unknown';

export interface IncomeFact {
  id: string; name: string; currency: Currency;
  amountMinor: number | null; amountStatus: FactStatus;
  frequency: 'monthly' | 'semimonthly' | null;
  day: number | null; dayMax: number | null; secondDay: number | null; dayStatus: FactStatus;
}
export interface ObligationFact {
  id: string; name: string; kind: ObligationKind; currency: Currency;
  amountMinor: number | null; amountStatus: FactStatus;
  day: number | null; dayMax: number | null; dayStatus: FactStatus;
  /** "Lo pago en quincena": for a MONTHLY payment this is ambiguous, so Vels asks "¿el 15?" before storing a day. */
  dayHint?: 'quincena' | null;
}
export type DebtKind = 'card' | 'personal' | 'loan';
export interface DebtFact {
  id: string; name: string; kind: DebtKind; lender: string | null; institution: string | null; last4: string | null; currency: Currency;
  balanceMinor: number | null; balanceStatus: FactStatus;
  minimumMinor: number | null; dueDay: number | null;
  /** Loans (debts table columns): what was lent, the monthly installment and how many installments. Never derived:
   *  the pending balance is asked, not computed from principal − installments (interest makes that wrong). */
  loanType?: string | null;
  principalMinor?: number | null;
  installmentMinor?: number | null;
  installmentsTotal?: number | null;
  installmentsPaid?: number | null;
  installmentsLeft?: number | null;
}
export interface AccountFact { id: string; institution: string; kind: 'bank' | 'card'; last4: string | null }
export interface VariableFact { id: string; name: string; currency: Currency; amountMinor: number | null; amountStatus: FactStatus }

export interface Draft {
  incomes: IncomeFact[];
  obligations: ObligationFact[];
  debts: DebtFact[];
  accounts: AccountFact[];
  variable: VariableFact[];
  balance: { currency: Currency; amountMinor: number | null; status: FactStatus } | null;
  /** Question keys already asked once (never nag twice). */
  asked: string[];
  /** Groups the person said are complete ("no tengo más pagos", "no tengo tarjeta"). */
  done: Array<'obligations' | 'debts' | 'cards' | 'loans'>;
  /** Payments the person said do not apply ("no pago alquiler"): never asked about again. */
  declined?: string[];
  /** The question waiting for an answer: a bare "950" or "no sé" applies here. */
  pending: string | null;
  /** Facts read from an image, shown for confirmation; never applied without it. */
  vision: Patch[] | null;
}

export const emptyDraft = (): Draft => ({
  incomes: [], obligations: [], debts: [], accounts: [], variable: [], balance: null, asked: [], done: [], pending: null, vision: null,
});

/** One change the interpreter (local rules, Gemini, or a vision read) proposes. Always validated before merge. */
export type Patch =
  | { t: 'income'; name?: string; amountMinor?: number; currency?: Currency; approx?: boolean; unknownAmount?: boolean;
      day?: number; dayMax?: number; secondDay?: number; frequency?: 'monthly' | 'semimonthly'; approxDay?: boolean; isNew?: boolean }
  | { t: 'obligation'; kind: ObligationKind; name: string; amountMinor?: number; currency?: Currency; approx?: boolean; unknownAmount?: boolean;
      day?: number; dayMax?: number; approxDay?: boolean; quincena?: boolean }
  | { t: 'debt'; kind: DebtKind; name: string; lender?: string; institution?: string; last4?: string; currency?: Currency;
      balanceMinor?: number; approx?: boolean; unknownBalance?: boolean; minimumMinor?: number; dueDay?: number;
      /** Internal: the draft debt a pending question is about (never from Gemini). */
      id?: string;
      loanType?: string; principalMinor?: number; installmentMinor?: number; installmentsTotal?: number; installmentsPaid?: number; installmentsLeft?: number }
  | { t: 'account'; institution: string; kind: 'bank' | 'card'; last4?: string }
  | { t: 'variable'; name: string; amountMinor?: number; currency?: Currency; approx?: boolean; unknownAmount?: boolean }
  | { t: 'balance'; amountMinor?: number; currency?: Currency; unknown?: boolean }
  | { t: 'remove'; name: string; declined?: boolean }
  | { t: 'done'; group: 'obligations' | 'debts' | 'cards' | 'loans' };

/** A value without a subject ("950", "el 10", "no sé"): it answers the pending question. */
export interface Bare { amountMinor?: number; currency?: Currency; approx?: boolean; day?: number; dayMax?: number; unknown?: boolean; frequency?: 'monthly' | 'semimonthly';
  /** "Eso no lo pago" / "no lo tengo": the pending payment does not apply. */
  none?: boolean }

export interface Interpretation { patches: Patch[]; bare: Bare | null }

export type Operation = 'onboarding_extract' | 'assistant_answer' | 'vision_extract';
