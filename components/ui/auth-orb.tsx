/**
 * Decorative glass orb of the access screens: olive body, citron rim, soft halo and two fine orbits. Pure SVG
 * (no WebGL, video or images), static (no continuous motion), aria-hidden and never intercepts clicks. Colours come
 * from the brand tokens; the marbled texture is a fixed turbulence pattern clipped to the body. Rendered once
 * per page (fixed ids).
 */
export function AuthOrb({ className }: { className?: string }) {
  const accent = 'var(--brand-accent)';
  return (
    <svg className={className ? `auth-orb ${className}` : 'auth-orb'} viewBox="0 0 420 420" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="vorb-halo" cx="50%" cy="50%" r="50%">
          <stop offset="38%" style={{ stopColor: accent, stopOpacity: 0.26 }} />
          <stop offset="62%" style={{ stopColor: accent, stopOpacity: 0.07 }} />
          <stop offset="100%" style={{ stopColor: accent, stopOpacity: 0 }} />
        </radialGradient>
        <radialGradient id="vorb-body" cx="46%" cy="44%" r="58%">
          <stop offset="0%" style={{ stopColor: 'color-mix(in srgb, var(--bg-primary) 92%, var(--brand-accent))' }} />
          <stop offset="55%" style={{ stopColor: 'color-mix(in srgb, var(--bg-primary) 86%, var(--brand-accent))' }} />
          <stop offset="80%" style={{ stopColor: 'color-mix(in srgb, var(--bg-primary) 68%, var(--brand-accent))' }} />
          <stop offset="93%" style={{ stopColor: 'color-mix(in srgb, var(--bg-primary) 38%, var(--brand-accent))' }} />
          <stop offset="100%" style={{ stopColor: accent }} />
        </radialGradient>
        <radialGradient id="vorb-shine" cx="34%" cy="28%" r="36%">
          <stop offset="0%" style={{ stopColor: 'var(--text-primary)', stopOpacity: 0.16 }} />
          <stop offset="100%" style={{ stopColor: 'var(--text-primary)', stopOpacity: 0 }} />
        </radialGradient>
        <clipPath id="vorb-clip"><circle cx="210" cy="210" r="100" /></clipPath>
        <filter id="vorb-marble" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="3" seed="11" />
          <feColorMatrix type="matrix" values="0 0 0 0 0.89  0 0 0 0 0.92  0 0 0 0 0.54  0 0 0 2.2 -1.0" />
        </filter>
        <filter id="vorb-glow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="5" />
        </filter>
      </defs>
      <circle cx="210" cy="210" r="201" fill="none" style={{ stroke: accent }} strokeOpacity="0.12" strokeWidth="1" />
      <circle cx="210" cy="210" r="152" fill="none" style={{ stroke: accent }} strokeOpacity="0.16" strokeWidth="1" />
      <circle cx="210" cy="210" r="150" fill="url(#vorb-halo)" />
      <circle cx="210" cy="210" r="100" fill="url(#vorb-body)" />
      <g clipPath="url(#vorb-clip)" opacity="0.2">
        <rect x="110" y="110" width="200" height="200" filter="url(#vorb-marble)" />
      </g>
      <circle cx="210" cy="210" r="100" fill="url(#vorb-shine)" />
      <circle cx="210" cy="210" r="99" fill="none" style={{ stroke: accent }} strokeWidth="7" opacity="0.6" filter="url(#vorb-glow)" />
      <circle cx="210" cy="210" r="99.5" fill="none" style={{ stroke: accent }} strokeWidth="1.5" opacity="0.9" />
    </svg>
  );
}
