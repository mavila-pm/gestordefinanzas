import type { Metadata } from 'next';
import { Chat } from '../../../components/chat';
import { VelsHeader } from '../../../components/vels-identity';
import { velsOpen } from '../../../lib/assistant';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import type { ChatMessage } from '../../../src/ai/conversation';
import { assistantAction, clearAssistantAction } from './actions';

export const metadata: Metadata = { title: 'Vels · Velsuno' };


/** Vels full page (ADR-0011; route kept as /app/preguntar for existing links). Same core as the Vels bubble. */
export default async function VelsPage() {
  const supabase = await createSupabaseServerClient();
  const { messages, suggestions, greeting } = await velsOpen(supabase, '/app/preguntar');
  const welcome: ChatMessage = { id: 'welcome', role: 'velsuno', body: greeting, card: null };
  return (
    <main className="assistant-page" id="main">
      <div className="row" style={{ maxWidth: 640, width: '100%', margin: '0 auto' }}>
        <VelsHeader as="h1" />
        {messages.length > 0 && <form action={clearAssistantAction}><button type="submit" className="link">Limpiar conversación</button></form>}
      </div>
      <Chat initial={messages.length ? messages : [welcome]} suggestions={suggestions} send={assistantAction} camera label="Conversación con Vels"
        placeholder="Escríbele a Vels" />
    </main>
  );
}
