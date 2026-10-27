import type { BrandIcon, LocalIcon } from './icon';

export interface Item { href: string; match: string; label: string; icon: BrandIcon | LocalIcon; exact?: boolean }
export interface Group { title: string; items: Item[] }

const I = {
  resumen: { href: '/app', match: '/app', label: 'Resumen', icon: 'home', exact: true },
  movimientos: { href: '/app/movimientos?month=all', match: '/app/movimientos', label: 'Movimientos', icon: 'transfer' },
  ingresos: { href: '/app/ingresos', match: '/app/ingresos', label: 'Ingresos', icon: 'income' },
  gastos: { href: '/app/gastos', match: '/app/gastos', label: 'Gastos', icon: 'expense' },
  disponible: { href: '/app/plan', match: '/app/plan', label: 'Dinero disponible', icon: 'milestone' },
  pagos: { href: '/app/compromisos', match: '/app/compromisos', label: 'Próximos pagos', icon: 'bell' },
  balance: { href: '/app/balance', match: '/app/balance', label: 'Balance financiero', icon: 'gauge' },
  cuentas: { href: '/app/tarjetas', match: '/app/tarjetas', label: 'Cuentas y tarjetas', icon: 'cards' },
  deudas: { href: '/app/deudas', match: '/app/deudas', label: 'Deudas', icon: 'debt' },
  inversiones: { href: '/app/inversiones', match: '/app/inversiones', label: 'Inversiones', icon: 'wallet' },
  analisis: { href: '/app/analisis', match: '/app/analisis', label: 'Análisis', icon: 'analytics' },
  vels: { href: '/app/preguntar', match: '/app/preguntar', label: 'Vels', icon: 'chat' },
  ajustes: { href: '/app/ajustes', match: '/app/ajustes', label: 'Ajustes', icon: 'settings' },
} satisfies Record<string, Item>;

/**
 * Product hierarchy (UX audit 2026-10-15 §2.3): day to day (what is used most: Ingresos and Gastos have their own
 * place, one tap), planning, what the person owns and owes, understanding. Same groups on desktop and in "Más".
 */
export const GROUPS: Group[] = [
  { title: 'Día a día', items: [I.resumen, I.movimientos, I.ingresos, I.gastos] },
  { title: 'Planificar', items: [I.disponible, I.pagos, I.balance] },
  { title: 'Patrimonio', items: [I.cuentas, I.deudas, I.inversiones] },
  { title: 'Entender', items: [I.analisis, I.vels] },
];
/** Kept for callers that list the main destinations. */
export const PRIMARY: Item[] = [I.resumen, I.movimientos, I.disponible, I.pagos, I.analisis, I.vels];
/** Shown in the navigation only while something waits for review (with its count). */
export const REVIEW: Item = { href: '/app/revisar', match: '/app/revisar', label: 'Por revisar', icon: 'review' };
export const MONEY_SETUP: Item[] = [I.cuentas, { href: '/app/presupuestos', match: '/app/presupuestos', label: 'Límites de gasto', icon: 'categories' }];
/** Mobile bottom bar: five, the daily ones + Vels + Más. */
export const MOBILE: Item[] = [I.resumen, I.ingresos, I.gastos, I.vels, { href: '/app/mas', match: '/app/mas', label: 'Más', icon: 'more' }];
const IN_BAR = new Set(MOBILE.map((i) => i.match));
/** Destinations reached through "Más" on mobile, so that tab stays active on them. */
export const MORE_ITEMS: Item[] = [...GROUPS.flatMap((g) => g.items).filter((i) => !IN_BAR.has(i.match)), REVIEW, MONEY_SETUP[1]!, I.ajustes];
export const UNDER_MORE = MORE_ITEMS.map((i) => i.match).concat('/app/importar');
