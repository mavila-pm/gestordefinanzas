'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient, authUser } from '../../../lib/supabase/server';
import { presentName } from '../../../src/domain/profile';
import { parsePreferences } from '../../../src/web/preferences';
import type { ActionState } from '../actions';

const SAVE_ERROR = 'No se guardó. Intenta de nuevo.';

/** One Ajustes section at a time (whitelisted columns); RLS keeps the row the person's own. */
export async function savePreferencesAction(_p: ActionState, form: FormData): Promise<ActionState> {
  const cols = parsePreferences(form.get('section'), (k) => form.get(k));
  if (!cols) return { error: SAVE_ERROR };
  const supabase = await createSupabaseServerClient();
  const user = await authUser(supabase);
  if (!user) return { error: SAVE_ERROR };
  const { error } = await supabase.from('user_preferences').upsert({ user_id: user.id, ...cols, updated_at: new Date().toISOString() });
  if (error) return { error: error.code === '23503' ? 'Esa cuenta ya no está disponible.' : SAVE_ERROR };
  revalidatePath('/app', 'layout');
  return { message: 'Guardado.' };
}

/** "Cómo te llama Vels": a short name (never the email). Empty → the first given name again. */
export async function saveDisplayNameAction(_p: ActionState, form: FormData): Promise<ActionState> {
  const raw = form.get('displayName');
  const name = typeof raw === 'string' ? raw.normalize('NFC').trim().replace(/\s+/g, ' ') : '';
  if (name.length > 40 || /[\u0000-\u001f\u007f<>@]/.test(name)) return { error: 'Usa hasta 40 letras, sin símbolos.' };
  const supabase = await createSupabaseServerClient();
  const user = await authUser(supabase);
  if (!user) return { error: SAVE_ERROR };
  const { data: p } = await supabase.from('profiles').select('given_names').maybeSingle();
  const fallback = (p?.given_names as string | null)?.trim().split(/\s+/)[0] ?? null;
  const { error } = await supabase.from('profiles').update({ display_name: name || fallback, updated_at: new Date().toISOString() }).eq('user_id', user.id);
  if (error) return { error: SAVE_ERROR };
  revalidatePath('/app', 'layout');
  return { message: name ? `Listo, ${presentName(name)}.` : 'Guardado.' };
}

/** Signs out every other device; this one stays signed in (Supabase Auth, the person's own session). */
export async function signOutOthersAction(_p: ActionState, _form: FormData): Promise<ActionState> {
  const supabase = await createSupabaseServerClient();
  const user = await authUser(supabase);
  if (!user) return { error: 'Inicia sesión de nuevo.' };
  const { error } = await supabase.auth.signOut({ scope: 'others' });
  return error ? { error: 'No se pudo cerrar las otras sesiones. Intenta de nuevo.' } : { message: 'Cerramos tus otras sesiones.' };
}
