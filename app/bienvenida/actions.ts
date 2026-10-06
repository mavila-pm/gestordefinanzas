'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient, authUser } from '../../lib/supabase/server';
import {
  onboardingConversation, onboardingFinish, onboardingImages, onboardingLeave, onboardingSkip, onboardingSummary, onboardingText, onboardingVision,
} from '../../lib/onboarding';
import type { ChatState } from '../../src/ai/conversation';
import { emptyDraft } from '../../src/ai/types';
import { logLearning } from '../../lib/learning';
import type { ActionState } from '../app/actions';

const SKIP = new Set(['Después', 'No sé', 'No tengo más', 'Quincenal']);

/** One entry point for the onboarding conversation: text, a quick reply, a tap (op) or photos. */
export async function onboardingAction(_prev: ChatState, form: FormData): Promise<ChatState> {
  const supabase = await createSupabaseServerClient();
  const user = await authUser(supabase);
  if (!user) redirect('/login');
  try {
    const op = form.get('op');
    const reply = form.get('reply');
    const text = form.get('text');
    const images = form.getAll('images').filter((f): f is File => f instanceof File && f.size > 0);
    if (op === 'start') {
      const r = await onboardingFinish(supabase, user.id);
      if (!r.ok) return { messages: await onboardingConversation(supabase), error: 'No pudimos guardar tu configuración. Intenta de nuevo.' };
      revalidatePath('/app', 'layout');
      redirect('/app');
    }
    if (op === 'summary') await onboardingSummary(supabase, user.id);
    else if (op === 'vision_confirm' || op === 'vision_discard') await onboardingVision(supabase, user.id, op === 'vision_confirm');
    else if (typeof reply === 'string' && reply) await (SKIP.has(reply) ? onboardingSkip(supabase, user.id, reply) : onboardingText(supabase, user.id, reply));
    else if (images.length) await onboardingImages(supabase, user.id, images);
    else if (typeof text === 'string' && text.trim()) await onboardingText(supabase, user.id, text);
    return { messages: await onboardingConversation(supabase) };
  } catch (e) {
    if ((e as { digest?: string }).digest?.startsWith('NEXT_REDIRECT')) throw e;
    return { messages: await onboardingConversation(supabase), error: 'No pude responder ahora. Lo que me contaste está guardado.' };
  }
}

export async function leaveOnboarding() {
  const supabase = await createSupabaseServerClient();
  const user = await authUser(supabase);
  if (!user) redirect('/login');
  await onboardingLeave(supabase, user.id);
  redirect('/app');
}

/**
 * "Borrar conversación de bienvenida" (Lo que recuerda): forgets the chat and the facts draft. What was already
 * saved as payments, incomes or debts stays (editable where it lives); `applied` is kept so a demo reset stays exact.
 */
export async function forgetOnboardingAction(_p: ActionState, _form: FormData): Promise<ActionState> {
  const supabase = await createSupabaseServerClient();
  const user = await authUser(supabase);
  if (!user) return { error: 'Inicia sesión de nuevo.' };
  const { error: e1 } = await supabase.from('conversation_messages').delete().eq('thread', 'onboarding');
  const { error: e2 } = await supabase.from('onboarding_states').update({ facts: emptyDraft(), summary: null }).eq('user_id', user.id);
  if (e1 || e2) return { error: 'No se borró. Intenta de nuevo.' };
  await logLearning(supabase, user.id, 'onboarding', 'deleted');
  revalidatePath('/app', 'layout');
  return { message: 'Conversación borrada.' };
}
