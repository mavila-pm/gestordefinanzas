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

export interface SyncEventRow { channel: string; outcome: string; created_at: string; transaction_id: string | null }

export function describeSyncEvent(e: SyncEventRow): { channel: string; outcome: string; linkable: boolean } {
  return {
    channel: CHANNEL[e.channel] ?? 'Otra fuente',
    outcome: OUTCOME[e.outcome] ?? 'Procesado',
    linkable: !!e.transaction_id,
  };
}
