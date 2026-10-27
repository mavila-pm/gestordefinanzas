import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseServerClient } from './supabase/server';
import { CAP_FIELD, capSecret, verifyCapToken, type CapScope, type Spend } from './cap-core';

/** Single-use keys in the database (migration 040), under the visitor's own (usually anonymous) session. */
export function databaseSpend(supabase: SupabaseClient): Spend {
  return async (key, ttlSeconds) => {
    const { data, error } = await supabase.rpc('cap_spend', { p_key: key, p_ttl_seconds: ttlSeconds });
    if (error) throw new Error(`cap_spend ${error.code ?? 'failed'}`);
    return data === true;
  };
}

/**
 * Gate for a public auth action: true only when the form carries a valid, unexpired, never-used Cap token for this
 * scope. Logs the reason code only (never the token). Callers return CAP_ERROR on false, before any other work.
 */
export async function capPassed(form: FormData, scope: CapScope): Promise<boolean> {
  const secret = capSecret();
  const r = await verifyCapToken(secret, scope, form.get(CAP_FIELD), secret ? databaseSpend(await createSupabaseServerClient()) : async () => false);
  if (!r.ok) console.warn(JSON.stringify({ event: 'cap_rejected', scope, reason: r.reason }));
  return r.ok;
}
