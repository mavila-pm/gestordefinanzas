import type { Metadata } from 'next';
import { Chat } from '../../../components/chat';
import { loadMessages } from '../../../lib/onboarding';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import type { ChatMessage } from '../../../src/ai/conversation';
import { assistantAction, clearAssistantAction } from './actions';

export const metadata: Metadata = { title: 'Preguntar · Velsuno' };

const WELCOME: ChatMessage = {
  id: 'welcome', role: 'velsuno', body: 'Pregúntame por tu dinero, o muéstrame un recibo o estado de cuenta.',
  card: { replies: ['¿Cuánto tengo libre?', '¿Qué viene esta semana?', '¿Puedo gastar S/ 300?', '¿Qué pago primero?'] },
};

/** "Preguntar" (§20-§21): a tool inside Velsuno, not the whole product. Works without AI for the common questions. */
export default async function Preguntar() {
  const supabase = await createSupabaseServerClient();
  const messages = await loadMessages(supabase, 'assistant', 40);
  return (
    <main className="assistant-page" id="main">
      <div className="row" style={{ maxWidth: 640, width: '100%', margin: '0 auto' }}>
        <h1>Preguntar</h1>
        {messages.length > 0 && <form action={clearAssistantAction}><button type="submit" className="link">Limpiar conversación</button></form>}
      </div>
      <Chat initial={messages.length ? messages : [WELCOME]} send={assistantAction} camera label="Preguntar a Velsuno"
        placeholder="Ej.: ¿me alcanza para S/ 500?" />
    </main>
  );
}
