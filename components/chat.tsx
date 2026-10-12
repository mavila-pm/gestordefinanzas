'use client';

import Link from 'next/link';
import { startTransition, useActionState, useCallback, useEffect, useLayoutEffect, useOptimistic, useRef, useState } from 'react';
import type { ChatMessage, ChatState, MessageCard } from '../src/ai/conversation';
import { isNearBottom, onNewContent } from '../src/web/chat-scroll';
import { formatVels } from '../src/web/chat-format';
import { Icon } from './ui/icon';
import { VelsAvatar } from './vels-identity';

/**
 * Velsuno conversation (onboarding and "Preguntar"). A column of short messages, compact fact cards and a
 * composer with text + optional photo. Only the latest Velsuno message is interactive (no stale buttons).
 * Photos are downscaled and re-encoded in the browser (drops EXIF/GPS metadata) before upload.
 */
type Send = (prev: ChatState, form: FormData) => Promise<ChatState>;

const MAX_SIDE = 1600;
async function shrink(file: File): Promise<Blob> {
  try {
    // Not an image by content: let the server answer with the right message (never trust the name or type).
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const isImage = (head[0] === 0x89 && head[1] === 0x50) || (head[0] === 0xff && head[1] === 0xd8) || (head[8] === 0x57 && head[9] === 0x45);
    if (!isImage) return file;
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    // Already small (typical screenshot): send as is; the server strips metadata segments before any read.
    if (scale === 1 && file.size <= 1_500_000 && /^image\/(png|jpeg|webp)$/.test(file.type)) { bmp.close(); return file; }
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

/** Something to show: a title, rows, a summary, or (only while it is the live message) something to tap. */
const hasContent = (c: MessageCard, live: boolean) => !!(c.title || c.rows?.length || c.summary
  || (live && (c.replies?.length || c.actions?.length || c.links?.length || c.acts?.length)));

function Card({ card, live, delay, onOp, onReply, onCamera, onCorrect }: {
  card: MessageCard; live: boolean; delay?: number; onOp: (op: string) => void; onReply: (text: string) => void; onCamera: () => void; onCorrect: () => void;
}) {
  // No empty box: a card with nothing to show (old buttons, no rows) is not rendered at all.
  if (!hasContent(card, live)) return null;
  const onlyActions = !card.title && !card.rows?.length && !card.summary;
  return (
    <div className={onlyActions ? 'chat-card bare' : 'chat-card'} style={delay ? { animationDelay: `${delay}ms` } : undefined}>
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

const reducedMotion = () => typeof window === 'undefined' || window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'reduce';

/** A message as lines: "\n" starts a line, an empty line (or "\n\n") starts a new paragraph (more space). */
function linesOf(text: string): Array<{ text: string; gap: boolean }> {
  const out: Array<{ text: string; gap: boolean }> = [];
  let gap = false;
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (!t) { gap = out.length > 0; continue; }
    out.push({ text: t, gap });
    gap = false;
  }
  return out;
}

const LINE_PAUSE = 160;
const wordStep = (n: number) => Math.min(45, 1100 / Math.max(1, n));
/** Reveal time for a message: ~45 ms a word (never more than 1.1 s of words) plus a short pause at each new line. */
const revealMs = (text: string) => {
  const lines = linesOf(text);
  const n = lines.reduce((s, l) => s + l.text.split(/\s+/).length, 0);
  return Math.round(wordStep(n) * n + LINE_PAUSE * Math.max(0, lines.length - 1));
};

/**
 * A Vels message, line by line: each line is its own block, a blank line opens a paragraph. New messages "write
 * themselves" word by word, line after line (the full text is in the DOM from the start; only opacity is animated;
 * reduced motion: no animation).
 */
function MessageText({ text, animate }: { text: string; animate: boolean }) {
  const lines = linesOf(text);
  const n = lines.reduce((s, l) => s + l.text.split(/\s+/).length, 0);
  const step = wordStep(n);
  let at = 0;
  return (
    <p className="msg-text">
      {lines.map((l, li) => {
        if (li > 0) at += LINE_PAUSE;
        const words = l.text.split(/(\s+)/);
        return (
          <span key={li} className={l.gap ? 'msg-line gap' : 'msg-line'}>
            {animate ? words.map((w, i) => (w.trim() ? <span key={i} className="tw" style={{ animationDelay: `${Math.round((at += step) - step)}ms` }}>{w}</span> : w)) : l.text}
            {li < lines.length - 1 ? '\n' : null}
          </span>
        );
      })}
    </p>
  );
}

/** Example phrases typed and erased in the empty composer, once (never a loop); stops as soon as the person types. */
function useTypedHint(input: React.RefObject<HTMLTextAreaElement | null>, examples: string[] | undefined, fallback: string, startAfter: number) {
  useEffect(() => {
    const el = input.current;
    if (!el || !examples?.length || reducedMotion()) return;
    let cancelled = false;
    const timers: number[] = [];
    const wait = (ms: number) => new Promise<void>((r) => { timers.push(window.setTimeout(r, ms)); });
    const idle = () => !cancelled && !el.value && document.activeElement !== el;
    (async () => {
      await wait(startAfter);
      for (const ex of examples) {
        for (let i = 1; i <= ex.length; i++) { if (!idle()) return; el.placeholder = ex.slice(0, i); await wait(42); }
        await wait(1400);
        for (let i = ex.length; i >= 0; i--) { if (!idle()) return; el.placeholder = ex.slice(0, i); await wait(18); }
        await wait(250);
      }
    })().finally(() => { if (!cancelled) el.placeholder = fallback; });
    const stop = () => { cancelled = true; el.placeholder = fallback; };
    el.addEventListener('focus', stop, { once: true });
    return () => { cancelled = true; timers.forEach(clearTimeout); el.removeEventListener('focus', stop); el.placeholder = fallback; };
  }, [input, examples, fallback, startAfter]);
}

export function Chat(props: { initial: ChatMessage[]; send: Send; camera: boolean; placeholder: string; label: string; suggestions?: string[];
  /** First visit: the opening messages arrive one by one (three dots, then each line). */
  intro?: boolean; examples?: string[] }) {
  const [state, formAction, pending] = useActionState(props.send, { messages: props.initial });
  const [text, setText] = useState('');
  const [hint, setHint] = useState(props.placeholder);
  const list = useRef<HTMLOListElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const lastSent = useRef<FormData | null>(null);
  // What the person sent shows at once (it is only their own words, never a financial result); the server's
  // stored conversation replaces it when the answer arrives.
  const [messages, addSent] = useOptimistic(state.messages, (cur, m: ChatMessage) => [...cur, m]);
  const [reading, setReading] = useState(false);
  // Messages present at mount are history (no animation); later Vels messages reveal themselves. The opening of a
  // first visit is staged: dots → first line → dots → second line with its options.
  const seenIds = useRef(new Set(props.intro ? [] : props.initial.map((m) => m.id)));
  const introLen = props.intro ? props.initial.length : 0;
  const [stage, setStage] = useState(props.intro ? 0 : introLen);
  useEffect(() => {
    if (!props.intro) return;
    if (reducedMotion()) { setStage(introLen); return; }
    const timers: number[] = [];
    let at = 450;
    for (let i = 1; i <= introLen; i++) {
      timers.push(window.setTimeout(() => setStage(i), at));
      at += revealMs(formatVels(props.initial[i - 1]?.body ?? '')) + 500;
    }
    return () => timers.forEach(clearTimeout);
  }, [props.intro, introLen, props.initial]);
  useTypedHint(input, props.examples, props.placeholder, props.intro ? 4200 : 1200);

  // Scroll like a messaging app: follow new messages only at the bottom or right after the person sends; never pull
  // a reader back down while they read older messages (a "new messages" button appears instead).
  const atBottom = useRef(true);
  const ownSend = useRef(false);
  const seen = useRef(0);
  const [jump, setJump] = useState(false);
  const toBottom = useCallback((smooth = false) => {
    const el = list.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !window.matchMedia('(prefers-reduced-motion: reduce)').matches && document.documentElement.dataset.motion !== 'reduce' ? 'smooth' : 'auto' });
    atBottom.current = true;
    setJump(false);
  }, []);
  useLayoutEffect(() => { toBottom(); }, [toBottom]); // open at the latest message
  const count = messages.length + (pending || reading ? 1 : 0);
  useLayoutEffect(() => {
    const grew = count > seen.current;
    seen.current = count;
    const action = onNewContent({ nearBottom: atBottom.current, ownSend: ownSend.current, grew });
    ownSend.current = false;
    if (action === 'stick') toBottom();
    else if (action === 'notify') setJump(true);
  }, [count, toBottom]);
  useEffect(() => {
    // Keyboard opening, a card expanding, fonts loading: if the reader was at the bottom, stay there.
    const el = list.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (atBottom.current) el.scrollTop = el.scrollHeight; });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const onScroll = () => {
    const el = list.current;
    if (!el) return;
    atBottom.current = isNearBottom(el);
    if (atBottom.current) setJump(false);
  };
  const wasPending = useRef(false);
  useEffect(() => { if (wasPending.current && !pending) setReading(false); wasPending.current = pending; }, [pending]);

  const submit = (fd: FormData, echo?: string) => {
    lastSent.current = fd;
    ownSend.current = true; // what the person sends brings the view back to the end
    startTransition(() => {
      if (echo) addSent({ id: `sent-${Date.now()}`, role: 'user', body: echo, card: null });
      formAction(fd);
    });
  };
  const sendText = (t: string) => { const v = t.trim(); if (!v || pending) return; const fd = new FormData(); fd.set('text', v); setText(''); submit(fd, v); };
  const sendReply = (r: string) => { if (pending) return; const fd = new FormData(); fd.set('reply', r); submit(fd, r); };
  const sendOp = (op: string) => { if (pending) return; const fd = new FormData(); fd.set('op', op); submit(fd); };
  const onFiles = async (files: FileList | null) => {
    if (!files?.length || pending) return;
    setReading(true); // visible at once, while the photos are downscaled in the browser
    const count = Math.min(files.length, 3);
    const fd = new FormData();
    for (const f of [...files].slice(0, 3)) fd.append('images', await shrink(f), 'foto.jpg');
    if (file.current) file.current.value = '';
    submit(fd, count === 1 ? 'Foto enviada' : `${count} fotos enviadas`);
  };
  // The newest card with something to tap stays live even if plain text came after it (never strand "Empezar").
  const hasActions = (c: MessageCard | null) => !!c && !!(c.replies?.length || c.actions?.length || c.acts?.length || c.links?.length);
  const lastVelsuno = [...messages].reverse().find((m) => m.role === 'velsuno' && hasActions(m.card))?.id;

  const shown = stage >= introLen ? messages : messages.slice(0, stage);
  const introTyping = stage < introLen;
  // Once shown, a message is history: re-renders (a new message, a tap) never replay its animation.
  useEffect(() => { const t = window.setTimeout(() => { for (const m of shown) seenIds.current.add(m.id); }, 1600); return () => clearTimeout(t); });

  return (
    <div className="chat" aria-label={props.label}>
      <ol className="chat-list" ref={list} aria-live="polite" onScroll={onScroll} data-testid="chat-list">
        {shown.map((m, i) => {
          const animate = m.role === 'velsuno' && !seenIds.current.has(m.id) && !m.id.startsWith('sent-');
          return (
            <li key={m.id} className={`msg ${m.role}${m.role === 'velsuno' && shown[i - 1]?.role !== 'velsuno' ? ' first' : ''}${animate ? ' fresh' : ''}`} data-testid={m.role === 'velsuno' ? 'velsuno-msg' : 'user-msg'}>
              {m.role === 'velsuno' && shown[i - 1]?.role !== 'velsuno' && <span className="msg-avatar"><VelsAvatar size={28} /></span>}
              <MessageText text={m.role === 'velsuno' ? formatVels(m.body) : m.body} animate={animate} />
              {m.card && <Card card={props.camera ? m.card : { ...m.card, actions: m.card.actions?.filter((a) => a.kind !== 'camera') }} live={m.id === lastVelsuno && !pending} onOp={sendOp} onReply={sendReply}
                delay={animate ? revealMs(formatVels(m.body)) : undefined}
                onCamera={() => file.current?.click()} onCorrect={() => { setHint('Dime qué cambio, por ejemplo: "el carro es 900"'); input.current?.focus(); }} />}
            </li>
          );
        })}
        {introTyping && <li className="msg velsuno typing" aria-label="Escribiendo"><span /><span /><span /></li>}
        {(pending || reading) && (reading
          ? <li className="msg velsuno" role="status"><p className="muted">Leyendo…</p></li>
          : <li className="msg velsuno typing" aria-label="Escribiendo"><span /><span /><span /></li>)}
      </ol>
      {jump && (
        <button type="button" className="chat-jump" onClick={() => toBottom(true)} data-testid="chat-jump">
          <span aria-hidden="true">↓</span> Ir al final
        </button>
      )}
      {state.error && (
        <p role="alert" className="chat-error">{state.error}{' '}
          {lastSent.current && <button type="button" className="link" onClick={() => lastSent.current && submit(lastSent.current)}>Reintentar</button>}
        </p>
      )}
      {!pending && !text && (props.suggestions?.length ?? 0) > 0 && messages.length <= props.initial.length && (
        <div className="chat-actions vels-openers" data-testid="vels-openers">
          {props.suggestions!.map((q) => <button key={q} type="button" className="chip" onClick={() => sendReply(q)}>{q}</button>)}
        </div>
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
