/**
 * Catalogue of known subscription services: name, search aliases and a monogram. It is presentation only — never a
 * price (the person types what they pay) and never a claim of partnership. Logos are drawn locally as brand-coloured
 * monograms (`.sub-logo[data-provider]` in globals.css): no remote images, no tracking, a stable fallback for custom
 * services. Adding a provider is a code change here, never a schema change.
 */
export interface Provider { slug: string; name: string; mark: string; aliases: string[] }

export const PROVIDERS: readonly Provider[] = [
  { slug: 'netflix', name: 'Netflix', mark: 'N', aliases: ['netflix'] },
  { slug: 'disney-plus', name: 'Disney+', mark: 'D+', aliases: ['disney', 'disney plus', 'disneyplus'] },
  { slug: 'prime-video', name: 'Prime Video', mark: 'pv', aliases: ['prime video', 'amazon prime', 'prime', 'amazon'] },
  { slug: 'max', name: 'Max', mark: 'M', aliases: ['max', 'hbo', 'hbo max', 'hbomax'] },
  { slug: 'paramount-plus', name: 'Paramount+', mark: 'P+', aliases: ['paramount', 'paramount plus'] },
  { slug: 'spotify', name: 'Spotify', mark: 'S', aliases: ['spotify'] },
  { slug: 'youtube-premium', name: 'YouTube Premium', mark: 'YT', aliases: ['youtube', 'youtube premium', 'yt premium', 'youtube music'] },
  { slug: 'apple-music', name: 'Apple Music', mark: '♪', aliases: ['apple music'] },
  { slug: 'apple-tv', name: 'Apple TV+', mark: 'tv', aliases: ['apple tv', 'appletv'] },
  { slug: 'icloud', name: 'iCloud+', mark: 'iC', aliases: ['icloud', 'icloud plus', 'apple icloud'] },
  { slug: 'google-one', name: 'Google One', mark: 'G1', aliases: ['google one', 'google storage'] },
  { slug: 'microsoft-365', name: 'Microsoft 365', mark: 'M365', aliases: ['microsoft 365', 'office 365', 'office', 'microsoft'] },
  { slug: 'adobe', name: 'Adobe', mark: 'Ad', aliases: ['adobe', 'creative cloud', 'photoshop', 'lightroom'] },
  { slug: 'chatgpt', name: 'ChatGPT Plus', mark: 'AI', aliases: ['chatgpt', 'openai', 'chat gpt'] },
  { slug: 'crunchyroll', name: 'Crunchyroll', mark: 'C', aliases: ['crunchyroll'] },
  { slug: 'deezer', name: 'Deezer', mark: 'Dz', aliases: ['deezer'] },
  { slug: 'canva', name: 'Canva Pro', mark: 'Cv', aliases: ['canva'] },
  { slug: 'duolingo', name: 'Duolingo', mark: 'Du', aliases: ['duolingo'] },
] as const;

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
const BY_SLUG = new Map(PROVIDERS.map((p) => [p.slug, p]));
export const providerBySlug = (slug: string | null | undefined): Provider | null => (slug ? BY_SLUG.get(slug) ?? null : null);

/**
 * The catalogue entry a free text names ("Netflix", "pago HBO MAX", "Disney Plus"), or null. Whole-word match on the
 * folded text, longest alias first, so "apple music" is not read as "apple tv" and "prime" needs a word boundary.
 */
export function matchProvider(text: string): Provider | null {
  // "Disney+" / "Paramount+" are written with a plus: read it as the word, so aliases stay plain words.
  const t = ` ${fold(text).replace(/\+/g, ' plus ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()} `;
  let best: { p: Provider; len: number } | null = null;
  for (const p of PROVIDERS) for (const a of p.aliases) {
    if (t.includes(` ${a} `) && (!best || a.length > best.len)) best = { p, len: a.length };
  }
  return best?.p ?? null;
}

/** Search for the picker: name or alias contains the folded query. Empty query → the whole catalogue. */
export function searchProviders(query: string): Provider[] {
  const q = fold(query).trim();
  if (!q) return [...PROVIDERS];
  return PROVIDERS.filter((p) => fold(p.name).includes(q) || p.aliases.some((a) => a.includes(q)));
}

/** Monogram for a custom service: first letters of up to two words ("Mi gimnasio" → "MG"). */
export function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? '?').slice(0, 2)).toUpperCase();
}
