'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { resetDemoOnboarding } from '../../../lib/onboarding';
import { createSupabaseServerClient, authUser } from '../../../lib/supabase/server';
import type { ActionState } from '../actions';

/** Demo/QA only (§76-§78): allowlisted accounts. The database refuses everyone else (set_demo_plan → not_demo). */
export async function setDemoPlanAction(_p: ActionState, form: FormData): Promise<ActionState> {
  const plan = form.get('plan');
  const value = plan === 'free' || plan === 'trial' || plan === 'plus' ? plan : null;
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('set_demo_plan', { p_plan: value });
  if (error) return { error: 'Esta cuenta no tiene modo demo.' };
  revalidatePath('/app/ajustes/plan');
  return { message: value ? 'Simulación activada. Tu suscripción real no cambió.' : 'Volviste a tu plan real.' };
}

export async function resetDemoOnboardingAction(_p: ActionState): Promise<ActionState> {
  const supabase = await createSupabaseServerClient();
  const user = await authUser(supabase);
  if (!user) redirect('/login');
  const r = await resetDemoOnboarding(supabase, user.id);
  if (!r.ok) return { error: 'Esta cuenta no tiene modo demo.' };
  revalidatePath('/app', 'layout');
  redirect('/bienvenida');
}

/** Anyone: reopen the conversational setup later ("Ahora no" never loses progress). */
export async function resumeOnboardingAction() {
  const supabase = await createSupabaseServerClient();
  const user = await authUser(supabase);
  if (!user) redirect('/login');
  const { onboardingResume } = await import('../../../lib/onboarding');
  await onboardingResume(supabase, user.id);
  redirect('/bienvenida');
}
