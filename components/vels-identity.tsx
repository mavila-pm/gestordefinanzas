'use client';

import { useEffect, useState } from 'react';
import { velsStatus } from '../src/web/chat-scroll';
import Image from 'next/image';

/** Pre-sized derivatives of the approved illustration (brand/vels/vels-avatar-source.webp): ≥2× the shown size. */
const AVATAR_SRC = (size: number) => `/brand/vels/vels-avatar-${size <= 32 ? 64 : size <= 64 ? 128 : 256}.png`;

/**
 * Vels's avatar: the approved illustration, cropped to face + shoulders, in a circle. Decorative (alt="") because
 * the name "Vels" is always next to it or in the control's label. Files are already sized and optimized, so the
 * image is served as is (no runtime resize).
 */
export function VelsAvatar({ size = 32 }: { size?: number }) {
  return (
    <span className="vels-avatar" style={{ width: size, height: size }}>
      <Image src={AVATAR_SRC(size)} alt="" width={size} height={size} unoptimized draggable={false} />
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
      <VelsAvatar size={44} />
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
