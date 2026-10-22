/** Plain-language labels for the sync history (spec §52): no parser names, fingerprints or internal codes. */
const CHANNEL: Record<string, string> = { email: 'Correo del banco', sms: 'SMS', import: 'Mensaje pegado', manual: 'Registro manual' };
const OUTCOME: Record<string, string> = {
  created: 'Movimiento nuevo',
  duplicate_same_event: 'Repetido: ya lo teníamos',
  merged_cross_source: 'Unido a un movimiento que ya tenías',
  possible_duplicate: 'Posible duplicado: revísalo',
  unresolved: 'No pudimos leerlo',
  non_transactional: 'Aviso sin movimiento de dinero',
  not_financial: 'No era una notificación bancaria',
  rejected: 'Rechazado por seguridad',
};

/**
 * A rejection by the Free plan limits (spec §81, assert_auto_allowance) is not a security problem: say what happened and
 * what to do, so a delivered email that created nothing is never silent. Only these fixed codes are mapped; the stored
 * detail itself is never shown.
 */
const PLAN_LIMIT: Record<string, string> = {
  plan_auto_limit: 'No se registró: llegaste al límite automático del mes. Regístralo a mano',
  plan_institution_limit: 'No se registró: tu plan Free automatiza un solo banco. Regístralo a mano',
};

export interface SyncEventRow { channel: string; outcome: string; created_at: string; transaction_id: string | null; detail?: string | null }

export function describeSyncEvent(e: SyncEventRow): { channel: string; outcome: string; linkable: boolean } {
  const planLimit = e.outcome === 'rejected' && e.detail && Object.hasOwn(PLAN_LIMIT, e.detail) ? PLAN_LIMIT[e.detail] : undefined;
  return {
    channel: CHANNEL[e.channel] ?? 'Otra fuente',
    outcome: planLimit ?? OUTCOME[e.outcome] ?? 'Procesado',
    linkable: !!e.transaction_id,
  };
}
