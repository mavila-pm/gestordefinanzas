import type { Currency } from '../domain/money';

export const INVESTMENT_KINDS = ['plazo_fijo', 'fondo_mutuo', 'acciones', 'etf', 'cripto', 'bonos', 'afp_voluntario', 'inmueble', 'negocio', 'otro'] as const;
export type InvestmentKind = (typeof INVESTMENT_KINDS)[number];
export const KIND_LABEL: Record<InvestmentKind, string> = {
  plazo_fijo: 'Plazo fijo', fondo_mutuo: 'Fondo mutuo', acciones: 'Acciones', etf: 'ETF', cripto: 'Cripto', bonos: 'Bonos',
  afp_voluntario: 'AFP voluntario', inmueble: 'Inmueble', negocio: 'Negocio', otro: 'Otro',
};

export interface InvestmentPosition {
  currency: Currency;
  /** Σ aportes − Σ retiros (real, typed by the person). */
  contributedMinor: number;
  /** Last valuation the person registered ("hoy vale"); null = unknown, never the contributed amount. */
  valueMinor: number | null;
  valueOn: string | null;
  /** value − contributed, only when the value is known. Estimated: it is the person's reading, not a quote. */
  gainMinor: number | null;
  /** gain / contributed in basis points, when both are known and something was contributed. */
  gainBp: number | null;
}

/**
 * Manual tracking only (MOTHER §89): Velsuno never quotes, ranks or advises. A position is what the person registered.
 * Totals per currency (PEN ≠ USD); a total value is shown only when every investment of that currency has one.
 */
export function position(currency: Currency, contributedMinor: number, valueMinor: number | null, valueOn: string | null): InvestmentPosition {
  const gainMinor = valueMinor === null ? null : valueMinor - contributedMinor;
  return { currency, contributedMinor, valueMinor, valueOn, gainMinor, gainBp: gainMinor !== null && contributedMinor > 0 ? Math.round((gainMinor * 10000) / contributedMinor) : null };
}

export function totals(items: readonly InvestmentPosition[], currency: Currency): { contributedMinor: number; valueMinor: number | null; missingValue: number } {
  const of = items.filter((i) => i.currency === currency);
  const missingValue = of.filter((i) => i.valueMinor === null).length;
  return {
    contributedMinor: of.reduce((s, i) => s + i.contributedMinor, 0),
    valueMinor: of.length && missingValue === 0 ? of.reduce((s, i) => s + (i.valueMinor as number), 0) : null,
    missingValue,
  };
}
