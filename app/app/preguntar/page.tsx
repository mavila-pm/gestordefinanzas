import type { Metadata } from 'next';
import { Chat } from '../../../components/chat';
import { velsOpen } from '../../../lib/assistant';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import type { ChatMessage } from '../../../src/ai/conversation';
import { assistantAction, clearAssistantAction } from './actions';

export const metadata: Metadata = { title: 'Vels · Velsuno' };

const WELCOME: ChatMessage = { id: 'welcome', role: 'velsuno', body: 'Hola, soy Vels. Cuéntame o pregúntame por tu dinero. También puedo leer una foto.', card: null };

/** Vels full page (ADR-0011; route kept as /app/preguntar for existing links). Same core as the Vels bubble. */
export default async function VelsPage() {
  const supabase = await createSupabaseServerClient();
  const { messages, suggestions } = await velsOpen(supabase, '/app/preguntar');
  return (
    <main className="assistant-page" id="main">
      <div className="row" style={{ maxWidth: 640, width: '100%', margin: '0 auto' }}>
        <h1>Vels</h1>
        {messages.length > 0 && <form action={clearAssistantAction}><button type="submit" className="link">Limpiar conversación</button></form>}
      </div>
      <Chat initial={messages.length ? messages : [WELCOME]} suggestions={suggestions} send={assistantAction} camera label="Conversación con Vels"
        placeholder="Escríbele a Vels" />
    </main>
  );
}
