import type { Metadata } from 'next';
import { Chat } from '../../../components/chat';
import { VelsHeader } from '../../../components/vels-identity';
import { velsOpen } from '../../../lib/vels';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import type { ChatMessage } from '../../../src/ai/conversation';
import { assistantAction, clearAssistantAction } from './actions';

export const metadata: Metadata = { title: 'Vels · Velsuno' };


/** Vels full page (ADR-0011; route kept as /app/preguntar for existing links). Same core as the Vels bubble. */
/** Arriving from a section's "Contárselo a Vels": the sentence starts for the person, so a bare "5000 de Negocio 1" is clear. */
const TOPIC: Record<string, { draft: string; placeholder: string }> = {
  ingreso: { draft: 'Recibí ', placeholder: 'Ej. Recibí 5000 soles de Negocio 1' },
  gasto: { draft: 'Gasté ', placeholder: 'Ej. Gasté 45 en almuerzo con mi débito' },
  deuda: { draft: 'Debo ', placeholder: 'Ej. Debo 1200 a Roberto, le pago 100 al mes' },
  inversion: { draft: 'Invertí ', placeholder: 'Ej. Invertí 2000 en un fondo mutuo' },
};

export default async function VelsPage({ searchParams }: { searchParams: Promise<{ tema?: string }> }) {
  const { tema } = await searchParams;
  const topic = tema ? TOPIC[tema] : undefined;
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
        placeholder={topic?.placeholder ?? 'Escríbele a Vels'} draft={topic?.draft} />
    </main>
  );
}
