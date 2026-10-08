import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AITestForm } from '../../../components/ai-test-form';
import { aiConfig, providerFor } from '../../../src/ai/config';
import { aiTestEnabled } from '../../../src/web/ai-chat-input';

export const metadata: Metadata = { title: 'Prueba de IA · Velsuno', robots: { index: false } };

/** Temporary technical check of the AI layer (not the assistant). Off production unless AI_TEST_ENDPOINT=1. */
export default function AITestPage() {
  if (!aiTestEnabled()) notFound();
  const ready = !!providerFor(aiConfig().provider);
  return (
    <main className="stack narrow-md" id="main">
      <h1>Prueba de IA</h1>
      <p className="muted">Prueba técnica: envía un mensaje y muestra la respuesta del modelo. No ve tus datos.</p>
      {!ready && <p className="notice" role="status">La IA no está activa en este entorno. Falta GEMINI_API_KEY en el servidor.</p>}
      <AITestForm />
    </main>
  );
}
