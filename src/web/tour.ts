/**
 * The first-use tour of /app (pure: steps and bubble placement, no DOM). Each step points at a REAL element: the
 * selectors are tried in order and the first visible one wins, so the same step works on desktop (sidebar) and
 * mobile (bottom navigation, or "Más" for what lives there). A step whose element is missing on this screen is
 * shown centred with its fallback text, never pointing at something that does not exist.
 */
export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** CSS selectors, in order of preference. */
  targets: string[];
  /** When the winning target is the n-th selector or later, `via` explains where the thing lives (e.g. under "Más"). */
  via?: { from: number; text: string };
  examples?: string[];
}

const nav = (href: string) => [`.sidebar nav a[href="${href}"]`, `.bottom-nav a[href="${href}"]`];
const MORE = '.bottom-nav a[href="/app/mas"]';

export const TOUR_STEPS: TourStep[] = [
  { id: 'summary', title: 'Resumen', body: 'Aquí ves cómo va tu dinero.', targets: ['.dash .kpis', ...nav('/app')] },
  { id: 'available', title: 'Dinero disponible', body: 'Esto es lo que puedes usar considerando tus próximos pagos.',
    targets: ['[data-testid="free-summary"]', ...nav('/app/plan'), MORE], via: { from: 3, text: 'Lo encuentras en Más → Dinero disponible.' } },
  { id: 'movements', title: 'Ingresos y gastos', body: 'Registra y revisa lo que entra y lo que sale, cada uno en su lugar.', targets: nav('/app/gastos') },
  { id: 'upcoming', title: 'Próximos pagos y suscripciones', body: 'Aquí ves lo que tienes que pagar y cuándo.',
    targets: [...nav('/app/compromisos'), MORE], via: { from: 2, text: 'Lo encuentras en Más → Próximos pagos.' } },
  { id: 'cards', title: 'Tarjetas y cuentas', body: 'Organiza tus tarjetas, cuentas y fechas de pago.',
    targets: [...nav('/app/tarjetas'), MORE], via: { from: 2, text: 'Lo encuentras en Más → Cuentas y tarjetas.' } },
  { id: 'analysis', title: 'Análisis', body: 'Descubre en qué gastas más.',
    targets: [...nav('/app/analisis'), MORE], via: { from: 2, text: 'Lo encuentras en Más → Análisis.' } },
  { id: 'savings', title: 'Ahorro', body: 'Sigue el avance de tus metas.',
    targets: ['[data-testid="savings-goal"]', ...nav('/app/balance'), MORE], via: { from: 1, text: 'Tus metas de ahorro e inversión están en Balance financiero.' } },
  { id: 'vels', title: 'Vels', body: '¿Tienes una duda? Pregúntame lo que quieras sobre tus finanzas. Te ayudo a registrar, consultar, analizar y planificar; las cifras las calcula Velsuno con tus datos.',
    targets: ['[data-testid="vels-fab"]', ...nav('/app/preguntar')],
    examples: ['Vels, gano S/ 3,500 al mes.', 'Pago Netflix el día 15.', 'Debo S/ 1,200 en mi tarjeta.', '¿Cuánto dinero tengo disponible?', '¿En qué estoy gastando más?', '¿Me alcanza para comprar algo de S/ 300?'] },
];

export interface Rect { top: number; left: number; width: number; height: number }
export interface Viewport { width: number; height: number; /** Space covered at the bottom (mobile navigation). */ bottomInset: number }
export type Side = 'right' | 'left' | 'below' | 'above' | 'center';
export interface Placement { top: number; left: number; side: Side; /** Arrow offset along the bubble edge, px. */ arrow: number }

const GAP = 14;
const MARGIN = 12;
/** Clamped to [lo, hi]; lo wins when the range is empty (a bubble taller than the screen starts at the top). */
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Where the bubble goes: beside the element when there is room (desktop sidebar), otherwise below or above it,
 * always inside the viewport and never over the bottom navigation. No target → centred.
 */
export function placeBubble(target: Rect | null, bubble: { width: number; height: number }, vp: Viewport): Placement {
  const usableBottom = vp.height - vp.bottomInset - MARGIN;
  if (!target) {
    return { top: clamp((usableBottom - bubble.height) / 2, MARGIN, usableBottom - bubble.height), left: clamp((vp.width - bubble.width) / 2, MARGIN, vp.width - bubble.width - MARGIN), side: 'center', arrow: 0 };
  }
  const cx = target.left + target.width / 2;
  const cy = target.top + target.height / 2;
  const vertical = (top: number) => clamp(top, MARGIN, usableBottom - bubble.height);
  const horizontal = (left: number) => clamp(left, MARGIN, vp.width - bubble.width - MARGIN);

  // Beside: only when the element is narrow enough to leave the bubble a full column (sidebar items).
  const rightSpace = vp.width - (target.left + target.width) - GAP - MARGIN;
  if (rightSpace >= bubble.width && target.width < vp.width / 2) {
    const top = vertical(cy - bubble.height / 2);
    return { top, left: target.left + target.width + GAP, side: 'right', arrow: clamp(cy - top, 16, bubble.height - 16) };
  }
  const leftSpace = target.left - GAP - MARGIN;
  if (leftSpace >= bubble.width && target.width < vp.width / 2) {
    const top = vertical(cy - bubble.height / 2);
    return { top, left: target.left - GAP - bubble.width, side: 'left', arrow: clamp(cy - top, 16, bubble.height - 16) };
  }
  const below = target.top + target.height + GAP;
  const fitsBelow = below + bubble.height <= usableBottom;
  const above = target.top - GAP - bubble.height;
  const fitsAbove = above >= MARGIN;
  // Elements near the bottom (navigation, Vels button) get the bubble above them; the rest prefer below.
  const side: Side = fitsBelow && !(fitsAbove && cy > vp.height / 2) ? 'below' : fitsAbove ? 'above' : 'below';
  const left = horizontal(cx - bubble.width / 2);
  const top = side === 'below' ? vertical(below) : vertical(above);
  return { top, left, side, arrow: clamp(cx - left, 16, bubble.width - 16) };
}

/** Step index kept within range (the stored progress may come from an older, longer tour). */
export function clampStep(i: number | null | undefined): number {
  if (typeof i !== 'number' || !Number.isInteger(i) || i < 0) return 0;
  return Math.min(i, TOUR_STEPS.length - 1);
}
