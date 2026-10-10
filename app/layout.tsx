import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { cookies } from 'next/headers';
import { reduceMotionFrom, textSizeFrom } from '../src/web/preferences';
import './globals.css';

/**
 * Manrope (brand font) as a Latin subset in WOFF2 (24 KB vs the 165 KB TTF), preloaded, with a metric-adjusted
 * fallback so the swap does not shift the layout (CLS). Built from brand/VELSUNO/fonts with fonttools pyftsubset.
 */
const velsunoSans = localFont({ src: './fonts/Manrope-latin.woff2', weight: '200 800', display: 'swap', variable: '--font-manrope', preload: true });

export const metadata: Metadata = {
  title: { default: 'Velsuno', template: '%s · Velsuno' },
  description: 'Tu dinero, más claro.',
  robots: { index: false },
  icons: {
    icon: [{ url: '/brand/icons/favicon.svg', type: 'image/svg+xml' }, { url: '/brand/icons/favicon-32x32.png', sizes: '32x32' }, { url: '/brand/icons/favicon.ico' }],
    apple: '/brand/icons/apple-touch-icon.png',
  },
  // og:image needs an absolute URL on a confirmed domain (brand handoff): added when the domain is decided.
};

export const viewport: Viewport = {
  width: 'device-width', initialScale: 1, viewportFit: 'cover', interactiveWidget: 'resizes-content',
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#F6F7F2' }, { media: '(prefers-color-scheme: dark)', color: '#10130F' }],
};


/** Follows the system until the person chooses; runs before paint so there is no light/dark flash. */
const SYSTEM_THEME = `document.documentElement.dataset.theme=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  const chosen = jar.get('vs-theme')?.value;
  const theme = chosen === 'light' || chosen === 'dark' ? chosen : undefined;
  // Device preferences (Ajustes → Apariencia / Accesibilidad), applied on the server: no flash, no layout jump.
  const text = textSizeFrom(jar.get('vs-text')?.value);
  const motion = reduceMotionFrom(jar.get('vs-motion')?.value) ? 'reduce' : undefined;
  return (
    <html lang="es-PE" data-theme={theme} data-text={text === 'md' ? undefined : text} data-motion={motion} className={velsunoSans.variable} suppressHydrationWarning>
      <head>{!theme && <script dangerouslySetInnerHTML={{ __html: SYSTEM_THEME }} />}</head>
      <body>{children}</body>
    </html>
  );
}
