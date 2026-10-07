import type { BrandIcon, LocalIcon } from './icon';

export interface Item { href: string; match: string; label: string; icon: BrandIcon | LocalIcon; exact?: boolean }

export const PRIMARY: Item[] = [
  { href: '/app', match: '/app', label: 'Resumen', icon: 'home', exact: true },
  { href: '/app/movimientos?month=all', match: '/app/movimientos', label: 'Movimientos', icon: 'transfer' },
  { href: '/app/revisar', match: '/app/revisar', label: 'Por revisar', icon: 'review' },
  { href: '/app/preguntar', match: '/app/preguntar', label: 'Vels', icon: 'chat' },
  { href: '/app/plan', match: '/app/plan', label: 'Dinero libre', icon: 'milestone' },
  { href: '/app/analisis', match: '/app/analisis', label: 'Análisis', icon: 'analytics' },
  { href: '/app/presupuestos', match: '/app/presupuestos', label: 'Presupuestos', icon: 'categories' },
  { href: '/app/compromisos', match: '/app/compromisos', label: 'Próximos pagos', icon: 'debt' },
];
export const SETUP: Item[] = [
  { href: '/app/tarjetas', match: '/app/tarjetas', label: 'Cuentas y tarjetas', icon: 'cards' },
  { href: '/app/reglas', match: '/app/reglas', label: 'Lo que recuerda', icon: 'check' },
  { href: '/app/conexiones', match: '/app/conexiones', label: 'Conexiones', icon: 'connections' },
  { href: '/app/cuenta', match: '/app/cuenta', label: 'Tu plan', icon: 'lock' },
  { href: '/app/ajustes', match: '/app/ajustes', label: 'Ajustes', icon: 'settings' },
];
export const MOBILE: Item[] = [
  PRIMARY[0]!, PRIMARY[1]!, { ...PRIMARY[2]!, label: 'Revisar' }, PRIMARY[3]!,
  { href: '/app/mas', match: '/app/mas', label: 'Más', icon: 'more' },
];
/** Destinations reached through "Más" on mobile, so that tab stays active on them. */
export const MORE_ITEMS = [...PRIMARY.slice(4), ...SETUP];
export const UNDER_MORE = MORE_ITEMS.map((i) => i.match).concat('/app/importar');
