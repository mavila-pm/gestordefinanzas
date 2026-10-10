'use client';

import { createContext, useCallback, useContext, useRef } from 'react';
import { Icon } from './icon';

/**
 * Contextual sheet: rises from the bottom on mobile (side panel from 768px) over the screen it belongs to, so the
 * context stays visible behind it. Native <dialog>: focus is trapped and returns to the trigger, Escape closes it.
 * Use it where keeping context beats a new page (split, edit, contextual actions) — not for everything.
 */
const SheetContext = createContext<{ close: () => void }>({ close: () => undefined });
export const useSheet = () => useContext(SheetContext);

export function Sheet(props: {
  label: React.ReactNode;
  triggerClassName?: string;
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
  triggerLabel?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useCallback(() => ref.current?.close(), []);
  const titleId = `sheet-${props.testId ?? props.title.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <>
      <button type="button" className={props.triggerClassName} aria-haspopup="dialog" aria-label={props.triggerLabel}
        onClick={() => ref.current?.showModal()}>{props.label}</button>
      <dialog ref={ref} className="sheet" aria-labelledby={titleId} data-testid={props.testId}
        onClick={(e) => { if (e.target === ref.current) close(); }}>
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-head">
          <div className="page-head">
            <h2 id={titleId}>{props.title}</h2>
            {props.subtitle && <div className="muted">{props.subtitle}</div>}
          </div>
          <button type="button" className="icon" onClick={close} aria-label="Cerrar"><Icon name="close" /></button>
        </div>
        <SheetContext.Provider value={{ close }}>{props.children}</SheetContext.Provider>
      </dialog>
    </>
  );
}
