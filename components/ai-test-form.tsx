'use client';
import { useState } from 'react';
import { AI_CHAT_MAX_CHARS } from '../src/web/ai-chat-input';

/** Calls the internal route only; the browser never talks to the provider and never sees a key. */
export function AITestForm() {
  const [message, setMessage] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !message.trim()) return;
    setBusy(true); setError(null); setAnswer(null);
    try {
      const res = await fetch('/api/ai/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }) });
      const data = await res.json().catch(() => ({})) as { response?: string; error?: string };
      if (res.ok && typeof data.response === 'string') setAnswer(data.response);
      else setError(data.error ?? 'No pude obtener respuesta. Intenta de nuevo.');
    } catch {
      setError('Sin conexión. Revisa tu internet e intenta de nuevo.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack-sm" onSubmit={send} aria-busy={busy} data-testid="ai-test">
      <label htmlFor="ai-msg">Mensaje</label>
      <textarea id="ai-msg" rows={3} maxLength={AI_CHAT_MAX_CHARS} placeholder="Escribe un mensaje…" value={message} onChange={(e) => setMessage(e.target.value)} />
      <button type="submit" disabled={busy || !message.trim()}>{busy ? 'Probando…' : 'Probar IA'}</button>
      {answer !== null && <div role="status" data-testid="ai-test-answer"><strong>Respuesta</strong><p style={{ whiteSpace: 'pre-wrap' }}>{answer}</p></div>}
      {error && <p role="alert" className="error">{error}</p>}
    </form>
  );
}
