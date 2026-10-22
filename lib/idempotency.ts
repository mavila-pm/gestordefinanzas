import type { PostgrestError } from '@supabase/supabase-js';

/**
 * Idempotent creates (ADR-0012). `ref()` reads the per-submission reference ActionForm sends (a fresh UUID per
 * form instance, renewed after a success); `isReplay()` recognizes the unique violation of `<table>_client_ref`,
 * which means "this exact submission was already stored" → answer success, never a duplicate row.
 */
export function ref(form: FormData): string | null {
  const v = form.get('client_ref');
  return typeof v === 'string' && /^[A-Za-z0-9:_-]{8,120}$/.test(v) ? v : null;
}
export const isReplay = (error: PostgrestError | null) => !!error && error.code === '23505' && /_client_ref/.test(`${error.message} ${error.details ?? ''}`);
