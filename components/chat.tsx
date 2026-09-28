'use client';

import Link from 'next/link';
import { startTransition, useActionState, useEffect, useRef, useState } from 'react';
import type { ChatMessage, ChatState, MessageCard } from '../src/ai/conversation';
import { Icon } from './ui/icon';

/**
 * Velsuno conversation (onboarding and "Preguntar"). A column of short messages, compact fact cards and a
 * composer with text + optional photo. Only the latest Velsuno message is interactive (no stale buttons).
 * Photos are downscaled and re-encoded in the browser (drops EXIF/GPS metadata) before upload.
 */
type Send = (prev: ChatState, form: FormData) => Promise<ChatState>;

const MAX_SIDE = 1600;
async function shrink(file: File): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', 0.85));
  } catch {
    return file; // the server validates and strips metadata anyway
  }
}

function Card({ card, live, onOp, onReply, onCamera, onCorrect }: {
  card: MessageCard; live: boolean; onOp: (op: string) => void; onReply: (text: string) => void; onCamera: () => void; onCorrect: () => void;
}) {
  return (
    <div className="chat-card">
      {card.title && <p className="chat-card-title">{card.title}</p>}
      {card.rows && card.rows.length > 0 && (
        <dl className="facts compact">
          {card.rows.map((r, i) => (
            <div key={i}><dt>{r.label}</dt><dd>{r.value}{r.doubtful && <span className="tag review">Confirma</span>}</dd></div>
          ))}
        </dl>
      )}
      {card.summary && (
        <div className="chat-summary" data-testid="onboarding-summary">
          {card.summary.groups.map((g) => (
            <section key={g.title}>
              <p className="caption">{g.title}</p>
              <dl className="facts compact">{g.items.map((r, i) => <div key={i}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}</dl>
            </section>
          ))}
          {card.summary.pending.length > 0 && (
            <section>
              <p className="caption">Por confirmar</p>
              <p className="muted small">{card.summary.pending.join(' · ')}</p>
            </section>
          )}
        </div>
      )}
      {live && (card.replies?.length || card.actions?.length || card.links?.length || card.acts?.length) ? (
        <div className="chat-actions">
          {card.replies?.map((r) => <button key={r} type="button" className="chip" onClick={() => onReply(r)}>{r}</button>)}
          {card.actions?.map((a) => (
            <button key={a.kind} type="button" className={a.kind === 'start' || a.kind === 'vision_confirm' ? 'button' : a.kind === 'camera' ? 'chip with-icon' : 'chip'}
              onClick={() => (a.kind === 'camera' ? onCamera() : a.kind === 'correct' ? onCorrect() : onOp(a.kind))}>
              {a.kind === 'camera' && <Icon name="camera" size={18} />}{a.label}
            </button>
          ))}
          {card.acts?.map((a) => (
            <button key={a.label} type="button" className="button" onClick={() => onOp(`act:${a.act}:${JSON.stringify(a.fields)}`)}>{a.label}</button>
          ))}
          {card.links?.map((l) => <Link key={l.href} href={l.href} className="chip">{l.label}</Link>)}
        </div>
      ) : null}
    </div>
  );
}

export function Chat(props: { initial: ChatMessage[]; send: Send; camera: boolean; placeholder: string; label: string }) {
  const [state, formAction, pending] = useActionState(props.send, { messages: props.initial });
  const [text, setText] = useState('');
  const [hint, setHint] = useState(props.placeholder);
  const list = useRef<HTMLOListElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const lastSent = useRef<FormData | null>(null);

  useEffect(() => { list.current?.lastElementChild?.scrollIntoView({ block: 'end' }); }, [state.messages, pending]);

  const submit = (fd: FormData) => { lastSent.current = fd; startTransition(() => formAction(fd)); };
  const sendText = (t: string) => { const v = t.trim(); if (!v || pending) return; const fd = new FormData(); fd.set('text', v); setText(''); submit(fd); };
  const sendReply = (r: string) => { if (pending) return; const fd = new FormData(); fd.set('reply', r); submit(fd); };
  const sendOp = (op: string) => { if (pending) return; const fd = new FormData(); fd.set('op', op); submit(fd); };
  const onFiles = async (files: FileList | null) => {
    if (!files?.length || pending) return;
    const fd = new FormData();
    for (const f of [...files].slice(0, 3)) fd.append('images', await shrink(f), 'foto.jpg');
    if (file.current) file.current.value = '';
    submit(fd);
  };
  const lastVelsuno = [...state.messages].reverse().find((m) => m.role === 'velsuno')?.id;

  return (
    <div className="chat" aria-label={props.label}>
      <ol className="chat-list" ref={list} aria-live="polite">
        {state.messages.map((m) => (
          <li key={m.id} className={`msg ${m.role}`} data-testid={m.role === 'velsuno' ? 'velsuno-msg' : 'user-msg'}>
            <p>{m.body}</p>
            {m.card && <Card card={props.camera ? m.card : { ...m.card, actions: m.card.actions?.filter((a) => a.kind !== 'camera') }} live={m.id === lastVelsuno && !pending} onOp={sendOp} onReply={sendReply}
              onCamera={() => file.current?.click()} onCorrect={() => { setHint('Dime qué cambio, por ejemplo: "el carro es 900"'); input.current?.focus(); }} />}
          </li>
        ))}
        {pending && <li className="msg velsuno typing" aria-label="Velsuno está escribiendo"><span /><span /><span /></li>}
      </ol>
      {state.error && (
        <p role="alert" className="chat-error">{state.error}{' '}
          {lastSent.current && <button type="button" className="link" onClick={() => lastSent.current && submit(lastSent.current)}>Reintentar</button>}
        </p>
      )}
      <form className="composer" onSubmit={(e) => { e.preventDefault(); sendText(text); }} aria-busy={pending}>
        {props.camera && (
          <>
            <button type="button" className="icon" aria-label="Foto o captura" onClick={() => file.current?.click()} disabled={pending}><Icon name="camera" size={22} /></button>
            <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => onFiles(e.target.files)} aria-label="Elegir foto o captura" />
          </>
        )}
        <label className="sr-only" htmlFor="chat-text">Mensaje</label>
        <textarea id="chat-text" ref={input} rows={1} value={text} placeholder={hint} maxLength={1500} disabled={pending}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(pointer: fine)').matches) { e.preventDefault(); sendText(text); } }} />
        <button type="submit" className="send" aria-label="Enviar" disabled={pending || !text.trim()}><Icon name="send" size={22} /></button>
      </form>
    </div>
  );
}
