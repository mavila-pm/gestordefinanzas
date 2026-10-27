'use client';

import { startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { finishTourAction } from '../app/app/tour-actions';
import { clampStep, placeBubble, TOUR_STEPS, type Placement, type Rect } from '../src/web/tour';

const KEY = 'velsuno:tour-step';
const PAD = 6;

const read = (): number => { try { return clampStep(Number(sessionStorage.getItem(KEY) ?? 0)); } catch { return 0; } };
const write = (i: number | null) => { try { if (i === null) sessionStorage.removeItem(KEY); else sessionStorage.setItem(KEY, String(i)); } catch { /* private mode: progress only for this view */ } };

/** First selector with a visible element (the sidebar is hidden on mobile, the bottom navigation on desktop). */
function findTarget(selectors: string[]): { el: Element; index: number } | null {
  for (const [index, s] of selectors.entries()) {
    for (const el of document.querySelectorAll(s)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden') return { el, index };
    }
  }
  return null;
}

function bottomInset(): number {
  const nav = document.querySelector('.bottom-nav');
  if (!nav) return 0;
  const r = nav.getBoundingClientRect();
  return r.height > 0 && getComputedStyle(nav).display !== 'none' ? window.innerHeight - r.top : 0;
}

/**
 * The first-use tour (after the conversation with Vels): dimmed page, the real element highlighted, a bubble with an
 * arrow beside it (desktop) or above/below it (mobile, never over the navigation). It never blocks: the page stays
 * usable, Saltar / Escape close it at any step, and finishing or skipping is saved for the account (Ajustes → Ayuda
 * starts it again). Progress survives navigation and reloads within the session.
 */
export function Tour({ show }: { show: boolean }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [via, setVia] = useState(false);
  const [place, setPlace] = useState<Placement | null>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const s = TOUR_STEPS[step]!;
  const last = step === TOUR_STEPS.length - 1;

  useEffect(() => {
    if (!show) return;
    if (new URLSearchParams(window.location.search).has('recorrido')) write(0);
    setStep(read());
    setOpen(true);
  }, [show]);

  const measure = useCallback(() => {
    const t = findTarget(s.targets);
    setVia(Boolean(t && s.via && t.index >= s.via.from));
    if (!t) { setRect(null); return; }
    const r = t.el.getBoundingClientRect();
    setRect({ top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 });
  }, [s]);

  // New step: bring its element into view, then measure before paint (no frame on the old spot); follow scroll/resize.
  useLayoutEffect(() => {
    if (!open) return;
    write(step);
    const t = findTarget(s.targets);
    if (t) {
      const r = t.el.getBoundingClientRect();
      const inset = bottomInset();
      if (r.top < 64 || r.bottom > window.innerHeight - inset - 24) {
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        t.el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      }
    }
    measure();
    let frame = 0;
    const onMove = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    window.addEventListener('scroll', onMove, { passive: true, capture: true });
    window.addEventListener('resize', onMove);
    // Route changes and late content (the page streams in) move things: re-measure briefly after each step.
    const late = window.setInterval(measure, 400);
    const stop = window.setTimeout(() => window.clearInterval(late), 2400);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onMove, { capture: true });
      window.removeEventListener('resize', onMove);
      window.clearInterval(late);
      window.clearTimeout(stop);
    };
  }, [open, step, s, measure]);

  useLayoutEffect(() => {
    if (!open || !bubble.current) return;
    const b = bubble.current.getBoundingClientRect();
    setPlace(placeBubble(rect, { width: b.width, height: b.height }, { width: window.innerWidth, height: window.innerHeight, bottomInset: bottomInset() }));
  }, [open, rect, step, via]);

  // Focus follows the step so keyboard and screen-reader users hear each one.
  useEffect(() => { if (open) bubble.current?.focus({ preventScroll: true }); }, [open, step]);

  const close = useCallback(() => {
    setOpen(false);
    write(null);
    startTransition(() => { void finishTourAction(); });
  }, []);
  const go = useCallback((d: 1 | -1) => setStep((i) => clampStep(i + d)), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowRight' && !last) go(1);
      else if (e.key === 'ArrowLeft' && step > 0) go(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, step, last, close, go]);

  if (!open) return null;
  const style = place ? { top: place.top, left: place.left, ['--arrow' as string]: `${place.arrow}px` } : { visibility: 'hidden' as const };
  return (
    <div className="tour" data-testid="tour" data-step={s.id}>
      {rect
        ? <div key={`spot-${s.id}`} className="tour-spot" style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }} aria-hidden="true" />
        : <div className="tour-dim" aria-hidden="true" />}
      <div key={`bubble-${s.id}`} ref={bubble} className="tour-bubble" data-side={place?.side ?? 'center'} style={style}
        role="dialog" aria-modal="false" aria-labelledby="tour-title" aria-describedby="tour-body" tabIndex={-1} data-testid="tour-bubble">
        <p className="tour-count muted small" aria-live="polite">{step + 1} de {TOUR_STEPS.length}</p>
        <h2 id="tour-title" className="tour-title">{s.title}</h2>
        <p id="tour-body">{s.body}</p>
        {via && s.via && <p className="muted small" data-testid="tour-via">{s.via.text}</p>}
        {!rect && !via && <p className="muted small">Aparecerá aquí cuando tengas datos.</p>}
        {s.examples && (
          <ul className="tour-examples" aria-label="Por ejemplo">
            {s.examples.map((x) => <li key={x}>«{x}»</li>)}
          </ul>
        )}
        <div className="tour-actions">
          <button type="button" className="link small-link" onClick={close} data-testid="tour-skip">Saltar</button>
          <span className="actions" style={{ gap: 8 }}>
            {step > 0 && <button type="button" className="secondary" onClick={() => go(-1)} data-testid="tour-prev">Anterior</button>}
            {last
              ? <button type="button" onClick={close} data-testid="tour-finish">Terminar</button>
              : <button type="button" onClick={() => go(1)} data-testid="tour-next">Siguiente</button>}
          </span>
        </div>
      </div>
    </div>
  );
}
