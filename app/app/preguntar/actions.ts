'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { velsAct, velsImages, velsTurn, velsVision, clearVels, velsOpen } from '../../../lib/vels';
import { loadMessages } from '../../../lib/onboarding';
import { createSupabaseServerClient, authUser } from '../../../lib/supabase/server';
import type { ChatState } from '../../../src/ai/conversation';

export async function assistantAction(_prev: ChatState, form: FormData): Promise<ChatState> {
  const supabase = await createSupabaseServerClient();
  const user = await authUser(supabase);
  if (!user) redirect('/login');
  try {
    const op = form.get('op');
    const reply = form.get('reply');
    const text = form.get('text');
    const images = form.getAll('images').filter((f): f is File => f instanceof File && f.size > 0);
    if (op === 'vision_confirm' || op === 'vision_discard') {
      await velsVision(supabase, user.id, op === 'vision_confirm');
      revalidatePath('/app', 'layout');
    } else if (images.length) {
      await velsImages(supabase, user.id, images);
    } else if (typeof op === 'string' && op.startsWith('act:')) {
      const [, act, json] = op.match(/^act:([a-z_]+):(.*)$/s) ?? [];
      let fields: Record<string, string> = {};
      try { fields = JSON.parse(json ?? '{}'); } catch { /* invalid → rejected below */ }
      const result = await velsAct(supabase, user.id, act ?? '', fields);
      await supabase.from('conversation_messages').insert({ user_id: user.id, thread: 'assistant', role: 'velsuno', body: result });
      revalidatePath('/app', 'layout');
    } else {
      const message = typeof reply === 'string' && reply ? reply : typeof text === 'string' ? text : '';
      if (message.trim()) await velsTurn(supabase, user.id, message);
    }
    return { messages: await loadMessages(supabase, 'assistant') };
  } catch {
    return { messages: await loadMessages(supabase, 'assistant'), error: 'No pude responder ahora. Intenta de nuevo.' };
  }
}

export async function clearAssistantAction() {
  const supabase = await createSupabaseServerClient();
  await clearVels(supabase);
  revalidatePath('/app/preguntar');
}

/** Vels opens instantly on the client; this fills it (recent messages + openers from the real state and screen). */
export async function velsOpenAction(path: string) {
  const supabase = await createSupabaseServerClient();
  const user = await authUser(supabase);
  if (!user) return { messages: [], suggestions: [], greeting: 'Hola. ¿Qué vemos hoy?' };
  return velsOpen(supabase, typeof path === 'string' ? path.slice(0, 80) : '/app');
}
