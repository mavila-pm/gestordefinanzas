import type { BrandIcon, LocalIcon } from './icon';

export interface Item { href: string; match: string; label: string; icon: BrandIcon | LocalIcon; exact?: boolean }

/** Product hierarchy: the situation, the movements, what is available, what comes, the depth, the assistant. */
export const PRIMARY: Item[] = [
  { href: '/app', match: '/app', label: 'Resumen', icon: 'home', exact: true },
  { href: '/app/movimientos?month=all', match: '/app/movimientos', label: 'Movimientos', icon: 'transfer' },
  { href: '/app/plan', match: '/app/plan', label: 'Dinero disponible', icon: 'milestone' },
  { href: '/app/compromisos', match: '/app/compromisos', label: 'Próximos pagos', icon: 'debt' },
  { href: '/app/analisis', match: '/app/analisis', label: 'Análisis', icon: 'analytics' },
  { href: '/app/preguntar', match: '/app/preguntar', label: 'Vels', icon: 'chat' },
];
/** Shown in the navigation only while something waits for review (with its count). */
export const REVIEW: Item = { href: '/app/revisar', match: '/app/revisar', label: 'Por revisar', icon: 'review' };
/** Reached from Más (mobile) and from Ajustes → Finanzas; not in the main navigation. */
export const MONEY_SETUP: Item[] = [
  { href: '/app/tarjetas', match: '/app/tarjetas', label: 'Cuentas y tarjetas', icon: 'cards' },
  { href: '/app/presupuestos', match: '/app/presupuestos', label: 'Límites de gasto', icon: 'categories' },
];
export const MOBILE: Item[] = [
  PRIMARY[0]!, PRIMARY[1]!, { ...PRIMARY[2]!, label: 'Disponible' }, PRIMARY[5]!,
  { href: '/app/mas', match: '/app/mas', label: 'Más', icon: 'more' },
];
/** Destinations reached through "Más" on mobile, so that tab stays active on them. */
export const MORE_ITEMS = [PRIMARY[3]!, PRIMARY[4]!, REVIEW, ...MONEY_SETUP, { href: '/app/ajustes', match: '/app/ajustes', label: 'Ajustes', icon: 'settings' } as Item];
export const UNDER_MORE = MORE_ITEMS.map((i) => i.match).concat('/app/importar');
