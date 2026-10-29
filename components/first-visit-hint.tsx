'use client';

import { useEffect, useState } from 'react';

/**
 * First-visit hint (UX audit §2.2): a small floating note under a section's title the first time the person opens it —
 * what the section is for and what to add first. "Entendido" hides it for good on this device (a per-device
 * convenience: nothing financial depends on it; storage blocked → it just shows once per visit).
 */
export function FirstVisitHint({ id, children }: { id: string; children: React.ReactNode }) {
  const key = `velsuno:hint:${id}`;
  const [show, setShow] = useState(false);
  useEffect(() => {
    try { setShow(localStorage.getItem(key) !== '1'); } catch { setShow(true); }
  }, [key]);
  if (!show) return null;
  const close = () => { try { localStorage.setItem(key, '1'); } catch { /* blocked storage: hide for this visit */ } setShow(false); };
  return (
    <div className="first-hint" role="note" data-testid={`hint-${id}`}>
      <span className="first-hint-tag">Nuevo</span>
      <p>{children}</p>
      <button type="button" className="link small" onClick={close}>Entendido</button>
    </div>
  );
}
