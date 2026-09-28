'use client';

import { usePathname } from 'next/navigation';
import { startTransition, useCallback, useRef, useState } from 'react';
import { assistantAction, velsOpenAction } from '../app/app/preguntar/actions';
import type { ChatMessage } from '../src/ai/conversation';
import { Chat } from './chat';
import { Icon } from './ui/icon';

const HELLO: ChatMessage = { id: 'vels-hello', role: 'velsuno', body: 'Hola, soy Vels. ¿En qué te ayudo?', card: null };

/**
 * Vels, always at hand (ADR-0011): a floating button on every /app screen. The panel opens at once (native
 * <dialog>: focus trap, Escape); the conversation and openers load right after, never blocking the open. Same
 * server actions and financial core as the Vels page — no second system.
 */
export function VelsBubble() {
  const path = usePathname();
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<{ messages: ChatMessage[]; suggestions: string[]; n: number } | null>(null);
  const load = useCallback((p: string) => startTransition(async () => {
    const r = await velsOpenAction(p);
    setState((s) => ({ messages: r.messages.length ? r.messages : [HELLO], suggestions: r.suggestions, n: (s?.n ?? 0) + 1 }));
  }), []);
  if (path.startsWith('/app/preguntar')) return null; // the full Vels page is already open
  const open = () => { dialog.current?.showModal(); load(path); };
  return (
    <>
      <button type="button" className="vels-fab" aria-label="Hablar con Vels" aria-haspopup="dialog" onClick={open} data-testid="vels-fab">
        <span aria-hidden="true">V</span>
      </button>
      <dialog ref={dialog} className="vels-panel" aria-labelledby="vels-title" data-testid="vels-panel"
        onClick={(e) => { if (e.target === dialog.current) dialog.current?.close(); }}>
        <div className="vels-head">
          <h2 id="vels-title">Vels</h2>
          <button type="button" className="icon" aria-label="Cerrar" onClick={() => dialog.current?.close()}><Icon name="close" /></button>
        </div>
        {state
          ? <Chat key={state.n} initial={state.messages} suggestions={state.suggestions} send={assistantAction} camera label="Conversación con Vels" placeholder="Escríbele a Vels" />
          : <div className="vels-loading" role="status" aria-label="Abriendo Vels"><span /><span /><span /></div>}
      </dialog>
    </>
  );
}
