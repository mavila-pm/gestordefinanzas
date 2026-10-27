'use client';

import Link, { useLinkStatus } from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from './icon';
import { GROUPS, MOBILE, REVIEW, UNDER_MORE, type Item } from './nav-items';

/** Marks the tapped item while its page loads: the tap answers at once, even before the server does. */
function Pending() {
  const { pending } = useLinkStatus();
  return pending ? <span className="nav-pending" data-nav-pending aria-hidden="true" /> : null;
}

function isActive(path: string, item: Item): boolean {
  if (item.match === '/app/mas') return path === '/app/mas' || UNDER_MORE.some((m) => path.startsWith(m));
  return item.exact ? path === item.match : path.startsWith(item.match);
}

function Links({ items, path, pending, testBadge }: { items: Item[]; path: string; pending: number; testBadge?: boolean }) {
  return items.map((item) => {
    const active = isActive(path, item);
    return (
      <li key={item.href}>
        <Link href={item.href} aria-current={active ? 'page' : undefined}>
          <Icon name={item.icon} />
          <span>{item.label}</span>
          <Pending />
          {item.match === '/app/revisar' && pending > 0 && (
            <span className="badge" data-testid={testBadge ? 'review-count' : undefined} aria-label={`${pending} por revisar`}>{pending}</span>
          )}
        </Link>
      </li>
    );
  });
}

export function SidebarNav({ pending }: { pending: number }) {
  const path = usePathname();
  return (
    <nav aria-label="Principal" className="nav-groups">
      {GROUPS.map((g, i) => (
        <div key={g.title} className="nav-group">
          <p className="nav-group-title" id={`nav-g-${i}`}>{g.title}</p>
          <ul className="nav-list" aria-labelledby={`nav-g-${i}`}>
            <Links items={i === 0 && pending > 0 ? [...g.items.slice(0, 2), REVIEW, ...g.items.slice(2)] : g.items} path={path} pending={pending} testBadge={i === 0} />
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function BottomNav({ pending }: { pending: number }) {
  const path = usePathname();
  return (
    <nav className="bottom-nav" aria-label="Principal">
      {MOBILE.map((item) => {
        const active = isActive(path, item);
        return (
          <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined}>
            <Icon name={item.icon} size={22} />
            <span>{item.label}</span>
            <Pending />
            {item.match === '/app/mas' && pending > 0 && <span className="badge" aria-label={`${pending} por revisar`}>{pending}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

