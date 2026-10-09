'use client';

import { useEffect, useState } from 'react';
import { velsStatus } from '../src/web/chat-scroll';
import { Isotipo } from './ui/logo';

/** Vels's avatar: the official Velsuno symbol in a circle (never a made-up human photo). */
export function VelsAvatar({ size = 32 }: { size?: number }) {
  return (
    <span className="vels-avatar" style={{ width: size, height: size }} aria-hidden="true">
      <Isotipo size={Math.round(size * 0.62)} />
    </span>
  );
}

/** Browser connectivity → header status. Back online shows "Reconectando…" briefly, then "Conectada". */
function useConnection() {
  const [online, setOnline] = useState(true);
  const [recovering, setRecovering] = useState(false);
  useEffect(() => {
    setOnline(navigator.onLine);
    let t: ReturnType<typeof setTimeout> | undefined;
    const up = () => { setOnline(true); setRecovering(true); clearTimeout(t); t = setTimeout(() => setRecovering(false), 1500); };
    const down = () => { setOnline(false); setRecovering(false); };
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); clearTimeout(t); };
  }, []);
  return velsStatus(online, recovering);
}

/**
 * Header of the Vels chat (panel and page): avatar · "Vels" · a small check that marks Velsuno's own assistant
 * (not an external verification) · connection status.
 */
export function VelsHeader({ titleId, as: Tag = 'h2' }: { titleId?: string; as?: 'h1' | 'h2' }) {
  const status = useConnection();
  return (
    <div className="vels-identity" data-testid="vels-identity">
      <VelsAvatar size={40} />
      <div className="vels-identity-text">
        <Tag id={titleId} className="vels-name">
          Vels
          <span className="vels-official" role="img" aria-label="Asistente oficial de Velsuno" title="Asistente oficial de Velsuno">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 8.5L7 11.5L12.5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
        </Tag>
        <span className={`vels-status ${status.tone}`} data-testid="vels-status" role="status"><span className="dot" aria-hidden="true" />{status.label}</span>
      </div>
    </div>
  );
}
