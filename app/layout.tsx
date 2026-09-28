import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import './globals.css';

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
  width: 'device-width', initialScale: 1, viewportFit: 'cover',
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#F6F7F2' }, { media: '(prefers-color-scheme: dark)', color: '#10130F' }],
};


/** Follows the system until the person chooses; runs before paint so there is no light/dark flash. */
const SYSTEM_THEME = `document.documentElement.dataset.theme=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const chosen = (await cookies()).get('vs-theme')?.value;
  const theme = chosen === 'light' || chosen === 'dark' ? chosen : undefined;
  return (
    <html lang="es-PE" data-theme={theme} suppressHydrationWarning>
      <head>{!theme && <script dangerouslySetInnerHTML={{ __html: SYSTEM_THEME }} />}</head>
      <body>{children}</body>
    </html>
  );
}
