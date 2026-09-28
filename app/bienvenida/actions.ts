'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '../../lib/supabase/server';
import {
  onboardingConversation, onboardingFinish, onboardingImages, onboardingLeave, onboardingSkip, onboardingSummary, onboardingText, onboardingVision,
} from '../../lib/onboarding';
import type { ChatState } from '../../src/ai/conversation';

const SKIP = new Set(['Después', 'No sé', 'No tengo más', 'Quincenal']);

/** One entry point for the onboarding conversation: text, a quick reply, a tap (op) or photos. */
export async function onboardingAction(_prev: ChatState, form: FormData): Promise<ChatState> {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
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
    return { messages: await onboardingConversation(supabase), error: 'Algo falló. Tu progreso está guardado.' };
  }
}

export async function leaveOnboarding() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  await onboardingLeave(supabase, user.id);
  redirect('/app');
}
