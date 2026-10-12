import type { Currency } from '../domain/money';

/**
 * Account preferences (Ajustes). Presentation and defaults only: none of them changes how money is computed,
 * validated or flagged. Appearance and accessibility live in cookies (per device, applied before paint).
 */
export type VelsStyle = 'brief' | 'balanced' | 'detailed';
export interface Preferences {
  velsStyle: VelsStyle;
  velsProactive: boolean;
  primaryCurrency: Currency;
  primaryAccountId: string | null;
  notifyUpcoming: boolean;
  notifyReview: boolean;
  notifyMonthly: boolean;
  notifyLimits: boolean;
}
export const DEFAULT_PREFERENCES: Preferences = {
  velsStyle: 'balanced', velsProactive: true, primaryCurrency: 'PEN', primaryAccountId: null,
  notifyUpcoming: true, notifyReview: true, notifyMonthly: true, notifyLimits: true,
};
export const VELS_STYLE_LABEL: Record<VelsStyle, string> = { brief: 'Breves', balanced: 'Equilibradas', detailed: 'Detalladas' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Get = (k: string) => unknown;

/** One section of the form → the columns it may change (whitelisted). Unknown section or value → null. */
export function parsePreferences(section: unknown, get: Get): Record<string, unknown> | null {
  const on = (k: string) => get(k) === 'on';
  if (section === 'vels') {
    const style = get('velsStyle');
    if (style !== 'brief' && style !== 'balanced' && style !== 'detailed') return null;
    return { vels_style: style, vels_proactive: on('velsProactive') };
  }
  if (section === 'finance') {
    const cur = get('primaryCurrency');
    const acc = get('primaryAccountId');
    if (cur !== 'PEN' && cur !== 'USD') return null;
    if (acc !== '' && acc !== null && acc !== undefined && !(typeof acc === 'string' && UUID.test(acc))) return null;
    return { primary_currency: cur, primary_account_id: typeof acc === 'string' && acc ? acc : null };
  }
  if (section === 'notifications') {
    return { notify_upcoming: on('notifyUpcoming'), notify_review: on('notifyReview'), notify_monthly: on('notifyMonthly'), notify_limits: on('notifyLimits') };
  }
  return null;
}

export function preferencesFrom(row: Record<string, unknown> | null | undefined): Preferences {
  if (!row) return DEFAULT_PREFERENCES;
  const style = row.vels_style;
  return {
    velsStyle: style === 'brief' || style === 'detailed' ? style : 'balanced',
    velsProactive: row.vels_proactive !== false,
    primaryCurrency: row.primary_currency === 'USD' ? 'USD' : 'PEN',
    primaryAccountId: typeof row.primary_account_id === 'string' ? row.primary_account_id : null,
    notifyUpcoming: row.notify_upcoming !== false, notifyReview: row.notify_review !== false,
    notifyMonthly: row.notify_monthly !== false, notifyLimits: row.notify_limits !== false,
  };
}

/** Alert codes from the engine → the notice the person can turn off (security notices are never optional). */
export function alertAllowed(code: string, p: Preferences): boolean {
  if (code.startsWith('budget_')) return p.notifyLimits;
  if (code.startsWith('debt_due') || code.startsWith('fixed_due') || code.startsWith('due')) return p.notifyUpcoming;
  if (code === 'pending' || code.startsWith('review')) return p.notifyReview;
  return true;
}

/** Device preferences (cookies), applied on <html> by the root layout. */
export const UI_COOKIES = { theme: 'vs-theme', text: 'vs-text', motion: 'vs-motion' } as const;
export type TextSize = 'sm' | 'md' | 'lg';
export const textSizeFrom = (v: string | undefined): TextSize => (v === 'sm' || v === 'lg' ? v : 'md');
export const reduceMotionFrom = (v: string | undefined) => v === 'reduce';
