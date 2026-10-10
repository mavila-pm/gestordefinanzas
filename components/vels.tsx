'use client';

import { usePathname } from 'next/navigation';
import { startTransition, useCallback, useRef, useState } from 'react';
import { assistantAction, clearAssistantAction, velsOpenAction } from '../app/app/preguntar/actions';
import type { ChatMessage } from '../src/ai/conversation';
import dynamic from 'next/dynamic';
import { Icon } from './ui/icon';
import { VelsAvatar, VelsHeader } from './vels-identity';

/** The chat (and its camera code) is not needed on every screen: it loads when Vels opens, in parallel with the data. */
const loadChat = () => import('./chat').then((m) => m.Chat);
const Chat = dynamic(loadChat, { ssr: false, loading: () => <div className="vels-loading" role="status" aria-label="Abriendo Vels"><span /><span /><span /></div> });


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
    setState((s) => ({ messages: r.messages.length ? r.messages : [{ id: 'vels-hello', role: 'velsuno', body: r.greeting, card: null }], suggestions: r.suggestions, n: (s?.n ?? 0) + 1 }));
  }), []);
  if (path.startsWith('/app/preguntar')) return null; // the full Vels page is already open
  const open = () => { dialog.current?.showModal(); void loadChat(); load(path); };
  const clear = () => startTransition(async () => { await clearAssistantAction(); load(path); });
  return (
    <>
      <button type="button" className="vels-fab" aria-label="Hablar con Vels" aria-haspopup="dialog" onClick={open} onPointerEnter={() => void loadChat()} data-testid="vels-fab">
        <VelsAvatar size={52} />
      </button>
      <dialog ref={dialog} className="vels-panel" aria-labelledby="vels-title" data-testid="vels-panel"
        onClick={(e) => { if (e.target === dialog.current) dialog.current?.close(); }}>
        <div className="vels-head">
          <VelsHeader titleId="vels-title" />
          <span className="actions" style={{ gap: 4 }}>
            {state && state.messages.some((m) => m.role === 'user') && <button type="button" className="link small-link" onClick={clear} data-testid="vels-clear">Limpiar</button>}
            <button type="button" className="icon" aria-label="Cerrar" onClick={() => dialog.current?.close()}><Icon name="close" /></button>
          </span>
        </div>
        {state
          ? <Chat key={state.n} initial={state.messages} suggestions={state.suggestions} send={assistantAction} camera label="Conversación con Vels" placeholder="Escríbele a Vels" />
          : <div className="vels-loading" role="status" aria-label="Abriendo Vels"><span /><span /><span /></div>}
      </dialog>
    </>
  );
}
