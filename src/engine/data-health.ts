/**
 * Data health (spec §58): HEALTHY / PARTIAL / ACTION_REQUIRED with the reasons, never a 0-100 score.
 */
export type DataHealthLevel = 'HEALTHY' | 'PARTIAL' | 'ACTION_REQUIRED';

export interface DataHealthInput {
  /** Movements in review_required / possible_duplicate. */
  pendingCount: number;
  /** Age in days of the oldest pending movement (null when none). */
  oldestPendingDays: number | null;
  /** Events in the last 30 days that could not be read (unresolved). */
  unresolvedEvents30d: number;
  /** Connected automatic sources (Email Bridge, Gmail, Android SMS). */
  automaticSources: number;
}

export interface DataHealth { level: DataHealthLevel; reasons: string[] }

export const PENDING_ACTION_THRESHOLD = 10;
export const PENDING_STALE_DAYS = 7;

export function dataHealth(i: DataHealthInput): DataHealth {
  const action: string[] = [];
  const partial: string[] = [];
  if (i.pendingCount >= PENDING_ACTION_THRESHOLD) action.push(`${i.pendingCount} movimientos por revisar`);
  else if (i.oldestPendingDays !== null && i.oldestPendingDays > PENDING_STALE_DAYS) action.push(`hay movimientos por revisar desde hace ${i.oldestPendingDays} días`);
  else if (i.pendingCount > 0) partial.push(`${i.pendingCount} movimiento(s) por revisar`);
  if (i.unresolvedEvents30d > 0) partial.push(`${i.unresolvedEvents30d} mensaje(s) del banco no se pudieron leer este mes`);
  if (i.automaticSources === 0) partial.push('aún no hay fuentes automáticas conectadas: las cifras dependen de lo que registres o importes');
  if (action.length) return { level: 'ACTION_REQUIRED', reasons: [...action, ...partial] };
  if (partial.length) return { level: 'PARTIAL', reasons: partial };
  return { level: 'HEALTHY', reasons: [] };
}
