import { monogram, providerBySlug } from '../src/domain/subscriptions';

/**
 * Service mark: a brand-coloured monogram drawn locally (no remote image, no tracking, no claim of partnership).
 * Unknown/custom services get a neutral monogram. Decorative: the name is always written next to it.
 */
export function SubLogo({ provider, name, size = 40 }: { provider: string | null; name: string; size?: number }) {
  const p = providerBySlug(provider);
  const mark = p?.mark ?? monogram(name);
  return (
    <span className="sub-logo" data-provider={p?.slug ?? 'custom'} aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * (mark.length > 2 ? 0.3 : 0.42)) }}>{mark}</span>
  );
}
