import type { TransactionType } from '../domain/types';

export const CATEGORIES = [
  'Alimentación', 'Transporte', 'Vivienda', 'Servicios', 'Salud',
  'Ocio', 'Educación', 'Personal', 'Otros',
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface MerchantRule {
  /** Substring matched against the normalized merchant. */
  contains: string;
  category: Category;
}

const LEGAL_SUFFIXES = /\b(S\.?A\.?C\.?|S\.?A\.?A\.?|S\.?A\.?|E\.?I\.?R\.?L\.?|S\.?R\.?L\.?)(?=\s|$)/g;
const PROCESSOR_PREFIXES = /^(PAYU|IZI|NIUBIZ|MP|DLC|CULQI)\s*\*\s*/;

/** Deterministic merchant normalization: no AI in the beta categorization path. */
export function normalizeMerchant(raw: string | null): string | null {
  if (!raw) return null;
  const v = raw
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(PROCESSOR_PREFIXES, '')
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/[^A-Z0-9& ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return v.length ? v : null;
}

/** Global rules for the Peruvian market. Word-boundary matched against normalized merchants. */
const GLOBAL_RULES: Array<[RegExp, Category]> = [
  [/\b(RESTAURANTE|POLLERIA|CHIFA|CEVICHERIA|CAFE|STARBUCKS|KFC|BEMBOS|PIZZA HUT|RAPPI|PEDIDOSYA|PLAZA VEA|TOTTUS|WONG|METRO|MAKRO|TAMBO|OXXO|MASS|VIVANDA)\b/, 'Alimentación'],
  [/\b(UBER|CABIFY|DIDI|INDRIVE|PRIMAX|REPSOL|PECSA|PETROPERU|LATAM|SKY AIRLINE)\b/, 'Transporte'],
  [/\b(LUZ DEL SUR|ENEL|SEDAPAL|CALIDDA|CLARO|MOVISTAR|ENTEL|BITEL|WIN)\b/, 'Servicios'],
  [/\b(INKAFARMA|MIFARMA|BOTICA|CLINICA|FARMACIA)\b/, 'Salud'],
  [/\b(NETFLIX|SPOTIFY|DISNEY|CINEPLANET|CINEMARK|STEAM)\b/, 'Ocio'],
  [/\b(UNIVERSIDAD|UPC|PUCP|COLEGIO|INSTITUTO|COURSERA|UDEMY)\b/, 'Educación'],
  [/\b(SODIMAC|PROMART|MAESTRO|ALQUILER)\b/, 'Vivienda'],
];

const CATEGORIZABLE: ReadonlySet<TransactionType> = new Set(['expense', 'credit_card_purchase', 'refund', 'reversal']);

/** merchant_raw -> normalization -> user rule -> global rule -> category. */
export function categorize(
  type: TransactionType,
  merchantNormalized: string | null,
  userRules: readonly MerchantRule[] = [],
): Category | null {
  if (!CATEGORIZABLE.has(type)) return null;
  if (!merchantNormalized) return 'Otros';
  const userHit = userRules.find((r) => merchantNormalized.includes(normalizeMerchant(r.contains) ?? '\u0000'));
  if (userHit) return userHit.category;
  return GLOBAL_RULES.find(([re]) => re.test(merchantNormalized))?.[1] ?? 'Otros';
}
