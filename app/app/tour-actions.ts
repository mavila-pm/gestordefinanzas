'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { authUser, createSupabaseServerClient } from '../../lib/supabase/server';

/** The tutorial was finished or skipped: remember it for this account (never shown again on sign-in). */
export async function finishTourAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const user = await authUser(supabase);
  if (!user) return;
  await supabase.from('user_preferences').upsert({ user_id: user.id, tour_completed_at: new Date().toISOString(), updated_at: new Date().toISOString() });
}

/** Ajustes → Ayuda → "Ver el recorrido otra vez": clears the mark and opens Resumen, where it starts. */
export async function restartTourAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const user = await authUser(supabase);
  if (!user) redirect('/login');
  await supabase.from('user_preferences').upsert({ user_id: user.id, tour_completed_at: null, updated_at: new Date().toISOString() });
  revalidatePath('/app', 'layout');
  redirect('/app?recorrido=1');
}
