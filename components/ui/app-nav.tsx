'use client';

import Link, { useLinkStatus } from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from './icon';
import { MOBILE, PRIMARY, SETUP, UNDER_MORE, type Item } from './nav-items';

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
    <nav aria-label="Principal">
      <ul className="nav-list"><Links items={PRIMARY} path={path} pending={pending} testBadge /></ul>
      <p className="nav-group caption">Configuración</p>
      <ul className="nav-list"><Links items={SETUP} path={path} pending={0} /></ul>
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
          <Pending />
            {item.match === '/app/revisar' && pending > 0 && <span className="badge" aria-hidden="true">{pending}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

