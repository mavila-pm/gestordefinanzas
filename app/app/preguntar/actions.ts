'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { assistantAct, assistantTurn, clearAssistant } from '../../../lib/assistant';
import { loadMessages } from '../../../lib/onboarding';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import type { ChatState } from '../../../src/ai/conversation';

export async function assistantAction(_prev: ChatState, form: FormData): Promise<ChatState> {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  try {
    const op = form.get('op');
    const reply = form.get('reply');
    const text = form.get('text');
    if (typeof op === 'string' && op.startsWith('act:')) {
      const [, act, json] = op.match(/^act:([a-z_]+):(.*)$/s) ?? [];
      let fields: Record<string, string> = {};
      try { fields = JSON.parse(json ?? '{}'); } catch { /* invalid → rejected below */ }
      const result = await assistantAct(supabase, user.id, act ?? '', fields);
      await supabase.from('conversation_messages').insert({ user_id: user.id, thread: 'assistant', role: 'velsuno', body: result });
      revalidatePath('/app', 'layout');
    } else {
      const message = typeof reply === 'string' && reply ? reply : typeof text === 'string' ? text : '';
      if (message.trim()) await assistantTurn(supabase, user.id, message);
    }
    return { messages: await loadMessages(supabase, 'assistant') };
  } catch {
    return { messages: await loadMessages(supabase, 'assistant'), error: 'No pude responder ahora. Intenta de nuevo.' };
  }
}

export async function clearAssistantAction() {
  const supabase = await createSupabaseServerClient();
  await clearAssistant(supabase);
  revalidatePath('/app/preguntar');
}
