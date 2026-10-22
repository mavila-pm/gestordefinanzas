import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { addDays } from '../src/domain/dates';
import { SNOOZE_DAYS, type Decision, type SuggestionKind } from '../src/engine/observed';

/**
 * Learned data ≠ financial events (ADR-0008). This module records the person's decisions on suggestions and an
 * append-only trail of changes to what Velsuno learned. It never writes or deletes transactions.
 */
export type LearningEntity = 'onboarding' | 'rule' | 'settlement' | 'obligation' | 'income' | 'essentials' | 'suggestion' | 'preference';
export type LearningAction = 'accepted' | 'corrected' | 'invalidated' | 'deleted' | 'dismissed' | 'snoozed' | 'restored';

/** Best effort by design: a failed trail row must not undo the person's change (it is logged server-side). */
export async function logLearning(supabase: SupabaseClient, userId: string, entity: LearningEntity, action: LearningAction,
  entityId: string | null = null, detail: Record<string, unknown> = {}): Promise<void> {
  const { error } = await supabase.from('learning_events').insert({ user_id: userId, entity, action, entity_id: entityId, detail });
  if (error) console.error('learning_event_failed', error.code);
}

export async function loadDecisions(supabase: SupabaseClient): Promise<Decision[]> {
  const { data } = await supabase.from('suggestion_decisions').select('kind,subject,value_minor,decision,until').limit(500);
  return (data ?? []).map((d) => ({ kind: d.kind, subject: d.subject, valueMinor: d.value_minor === null ? null : Number(d.value_minor), decision: d.decision, until: d.until }));
}

/** "Ahora no" (snooze) or "Descartar" (for this value). Idempotent: one decision per suggestion, last one wins. */
export async function decide(supabase: SupabaseClient, userId: string, kind: SuggestionKind, subject: string, valueMinor: number | null,
  decision: 'later' | 'dismissed', today: string): Promise<boolean> {
  const { error } = await supabase.from('suggestion_decisions').upsert({
    user_id: userId, kind, subject, value_minor: valueMinor, decision, until: decision === 'later' ? addDays(today, SNOOZE_DAYS) : null,
  }, { onConflict: 'user_id,kind,subject' });
  if (error) return false;
  await logLearning(supabase, userId, 'suggestion', decision === 'later' ? 'snoozed' : 'dismissed', null, { kind, subject, valueMinor });
  return true;
}
