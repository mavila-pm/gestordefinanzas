/**
 * Interface icons. Brand glyphs come from the official sprite (public/brand/icons/ui/sprite.svg, currentColor).
 * A few functional glyphs the brand set does not include are drawn here with the same grid (24), stroke (1.75) and
 * round caps. Icons are decorative by default (aria-hidden); give the control an accessible name instead.
 */
export type BrandIcon = 'income' | 'expense' | 'transfer' | 'cards' | 'institutions' | 'alerts' | 'analytics' | 'plus'
  | 'categories' | 'review' | 'milestone' | 'check' | 'home' | 'connections' | 'settings' | 'debt' | 'arrow-right'
  | 'lock' | 'search' | 'mail';

const LOCAL = {
  close: 'M6 6L18 18M18 6L6 18',
  user: 'M12 12A4 4 0 1 0 12 4A4 4 0 0 0 12 12ZM4.5 20C5.6 16.8 8.5 15 12 15S18.4 16.8 19.5 20',
  bell: 'M6 16V11A6 6 0 0 1 18 11V16L19.5 18H4.5L6 16ZM10 20.5A2 2 0 0 0 14 20.5',
  shield: 'M12 3L19 6V11C19 15.5 16 19 12 21C8 19 5 15.5 5 11V6L12 3Z',
  text: 'M5 7V5H19V7M12 5V19M9 19H15',
  palette: 'M12 3A9 9 0 1 0 12 21C13.2 21 13.6 20 13 19.2C12.4 18.4 12.9 17 14.2 17H16A5 5 0 0 0 21 12A9 9 0 0 0 12 3Z',
  wallet: 'M4 7H18A2 2 0 0 1 20 9V18A2 2 0 0 1 18 20H5A1 1 0 0 1 4 19V7ZM4 7L16 4V7M16 13.5H16.01',
  gauge: 'M4.5 17A8 8 0 1 1 19.5 17M12 14L15.5 9.5M12 14H12.01',
  doc: 'M7 3H14L18 7V21H7V3ZM14 3V7H18M10 12H15M10 16H15',
  add: 'M12 5V19M5 12H19',
  more: 'M5 12H5.01M12 12H12.01M19 12H19.01',
  chevron: 'M9 6L15 12L9 18',
  back: 'M15 6L9 12L15 18',
  split: 'M12 3V9M12 9L5 16V21M12 9L19 16V21',
  edit: 'M4 20H8L19 9L15 5L4 16V20Z',
  sun: 'M12 16A4 4 0 1 0 12 8A4 4 0 1 0 12 16ZM12 2V4M12 20V22M4.9 4.9L6.3 6.3M17.7 17.7L19.1 19.1M2 12H4M20 12H22M4.9 19.1L6.3 17.7M17.7 6.3L19.1 4.9',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4A8 8 0 1 0 20 14.5Z',
  logout: 'M15 4H19V20H15M10 8L6 12L10 16M6 12H15',
  trash: 'M4 7H20M9 7V4H15V7M6 7L7 20H17L18 7',
  camera: 'M4 8H7.5L9 6H15L16.5 8H20V19H4V8ZM12 16.5A3 3 0 1 0 12 10.5A3 3 0 1 0 12 16.5Z',
  send: 'M5 12H19M13 6L19 12L13 18',
  chat: 'M5 5H19V16H11L7 19.5V16H5V5ZM9 10.5H15',
  eye: 'M2.5 12C4.5 7.5 8 5.5 12 5.5S19.5 7.5 21.5 12C19.5 16.5 16 18.5 12 18.5S4.5 16.5 2.5 12ZM12 15A3 3 0 1 0 12 9A3 3 0 1 0 12 15Z',
  eyeOff: 'M2.5 12C4.5 7.5 8 5.5 12 5.5S19.5 7.5 21.5 12C19.5 16.5 16 18.5 12 18.5S4.5 16.5 2.5 12ZM12 15A3 3 0 1 0 12 9A3 3 0 1 0 12 15ZM4 20L20 4',
} as const;
export type LocalIcon = keyof typeof LOCAL;

export function Icon({ name, size = 20, className }: { name: BrandIcon | LocalIcon; size?: number; className?: string }) {
  const local = (LOCAL as Record<string, string>)[name];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className}>
      {local
        ? <path d={local} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
        : <use href={`/brand/icons/ui/sprite.svg#${name}`} />}
    </svg>
  );
}
