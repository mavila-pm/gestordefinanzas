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
  /** 'occasional': a one-off or irregular income. Shown, never projected as a recurring expected income. */
  frequency: 'monthly' | 'semimonthly' | 'occasional' | null;
  day: number | null; dayMax: number | null; secondDay: number | null; dayStatus: FactStatus;
  /** What the income is (shown in the summary): salary, own work (services, sales), rent, or other. */
  source?: 'salary' | 'independent' | 'rental' | 'other' | null;
  /** "A fin de mes": ambiguous until confirmed ('end' → asked "¿el último día?"; 'ask' → "¿qué día exactamente?"). */
  dayHint?: 'end' | 'ask' | null;
}
export interface ObligationFact {
  id: string; name: string; kind: ObligationKind; currency: Currency;
  amountMinor: number | null; amountStatus: FactStatus;
  day: number | null; dayMax: number | null; dayStatus: FactStatus;
  /** "Lo pago en quincena": for a MONTHLY payment this is ambiguous, so Vels asks "¿el 15?" before storing a day. */
  dayHint?: 'quincena' | 'end' | 'ask' | null;
}
export type DebtKind = 'card' | 'personal' | 'loan';
export interface DebtFact {
  id: string; name: string; kind: DebtKind; lender: string | null; institution: string | null; last4: string | null; currency: Currency;
  balanceMinor: number | null; balanceStatus: FactStatus;
  minimumMinor: number | null; dueDay: number | null;
  /** Credit card statement (cut-off) day → cards.statement_day when the card is registered (last 4 known). */
  cutDay?: number | null;
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
  /** Money today. amountMinor is the declared total; bankMinor / cashMinor keep the breakdown when it was said
   *  ("S/ 4,000 en mis cuentas y S/ 150 en efectivo"); a part not said stays null (unknown, never 0). */
  balance: { currency: Currency; amountMinor: number | null; status: FactStatus; bankMinor?: number | null; cashMinor?: number | null } | null;
  /** Question keys already asked once (never nag twice). */
  asked: string[];
  /** Groups the person said are complete ("no tengo más pagos", "no tengo tarjeta"). */
  done: Array<DoneGroup>;
  /** How the person earns (first question): orders the income questions; null = not said (generic order). */
  work?: 'employee' | 'independent' | 'both' | null;
  /** Monthly savings goal the person stated (planning_settings.savings_goal_minor at "Empezar"); unknown ≠ 0. */
  savings?: { currency: Currency; amountMinor: number | null; status: FactStatus } | null;
  /** Payments the person said do not apply ("no pago alquiler"): never asked about again. */
  declined?: string[];
  /** The question waiting for an answer: a bare "950" or "no sé" applies here. */
  pending: string | null;
  /** Facts read from an image, shown for confirmation; never applied without it. */
  vision: Patch[] | null;
}

export type DoneGroup = 'obligations' | 'debts' | 'cards' | 'loans' | 'subscriptions' | 'incomes';

export const emptyDraft = (): Draft => ({
  incomes: [], obligations: [], debts: [], accounts: [], variable: [], balance: null, asked: [], done: [], pending: null, vision: null,
});

/** One change the interpreter (local rules, Gemini, or a vision read) proposes. Always validated before merge. */
export type Patch =
  | { t: 'income'; /** Internal: the income a pending question is about (never from Gemini). */ id?: string; source?: 'salary' | 'independent' | 'rental' | 'other';
      /** Internal: "a fin de mes" said instead of a day (asked before storing any day). */ endHint?: boolean; name?: string; amountMinor?: number; currency?: Currency; approx?: boolean; unknownAmount?: boolean;
      day?: number; dayMax?: number; secondDay?: number; frequency?: 'monthly' | 'semimonthly' | 'occasional'; approxDay?: boolean; isNew?: boolean }
  | { t: 'obligation'; endHint?: boolean; kind: ObligationKind; name: string; amountMinor?: number; currency?: Currency; approx?: boolean; unknownAmount?: boolean;
      day?: number; dayMax?: number; approxDay?: boolean; quincena?: boolean }
  | { t: 'debt'; kind: DebtKind; name: string; lender?: string; institution?: string; last4?: string; currency?: Currency;
      balanceMinor?: number; approx?: boolean; unknownBalance?: boolean; minimumMinor?: number; dueDay?: number;
      /** Internal: the draft debt a pending question is about (never from Gemini). */
      id?: string;
      loanType?: string; principalMinor?: number; installmentMinor?: number; installmentsTotal?: number; installmentsPaid?: number; installmentsLeft?: number }
  | { t: 'account'; institution: string; kind: 'bank' | 'card'; last4?: string }
  | { t: 'variable'; name: string; amountMinor?: number; currency?: Currency; approx?: boolean; unknownAmount?: boolean }
  | { t: 'balance'; amountMinor?: number; currency?: Currency; unknown?: boolean; bankMinor?: number; cashMinor?: number }
  | { t: 'remove'; name: string; declined?: boolean }
  | { t: 'done'; group: DoneGroup };

/** A value without a subject ("950", "el 10", "no sé"): it answers the pending question. */
export interface Bare { amountMinor?: number; currency?: Currency; approx?: boolean; day?: number; dayMax?: number; unknown?: boolean; frequency?: 'monthly' | 'semimonthly';
  /** "Eso no lo pago" / "no lo tengo": the pending payment does not apply. */
  none?: boolean }

export interface Interpretation { patches: Patch[]; bare: Bare | null }

export type Operation = 'onboarding_extract' | 'assistant_answer' | 'vision_extract';
