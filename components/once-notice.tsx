'use client';

import { useEffect } from 'react';

/**
 * A notice that belongs to one landing only: once shown, the query parameter that asked for it is removed from the
 * address (no navigation, no reload), so a refresh or a shared link does not show it again.
 */
export function OnceNotice({ param, testId, children }: { param: string; testId?: string; children: React.ReactNode }) {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(param)) return;
    url.searchParams.delete(param);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, [param]);
  return <p role="status" className="notice" data-testid={testId}>{children}</p>;
}
