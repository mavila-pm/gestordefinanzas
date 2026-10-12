import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { preferencesFrom, type Preferences } from '../src/web/preferences';

/** The person's preferences (RLS: own row), or the defaults when none were saved yet. */
export async function loadPreferences(supabase: SupabaseClient): Promise<Preferences> {
  const { data } = await supabase.from('user_preferences')
    .select('vels_style,vels_proactive,primary_currency,primary_account_id,notify_upcoming,notify_review,notify_monthly,notify_limits').maybeSingle();
  return preferencesFrom(data);
}
