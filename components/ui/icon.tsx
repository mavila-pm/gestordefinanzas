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
