/**
 * Visual QA: real screenshots of the running app (no mockups) at the target breakpoints in light and dark, plus an
 * automatic check that no screen scrolls horizontally. Uses the seeded probe users (seed.sql: s78a rich data,
 * s10a split). Output: .e2e/shots/<screen>-<width>-<theme>.png and one summary line.
 * Run (server up, seeded): node --experimental-strip-types tests/e2e/visual.ts
 */
import { chromium, type Page } from 'playwright-core';
import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import { BASE, login, probe } from './lib.ts';

const WIDTHS = [320, 375, 390, 430, 768, 1024, 1280, 1440];
const FULL = new Set([375, 1280]); // every screen; the rest only for the overflow check + key screens
const OUT = '.e2e/shots';
mkdirSync(OUT, { recursive: true });
const root = '/opt/pw-browsers';
const dir = existsSync(root) ? readdirSync(root).find((d) => /^chromium-\d+$/.test(d)) : undefined;
const browser = await chromium.launch({ executablePath: dir ? `${root}/${dir}/chrome-linux/chrome` : undefined });
const overflow: string[] = [];
let shots = 0;

async function shoot(page: Page, name: string, width: number, theme: string, save: boolean) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 0) overflow.push(`${name}@${width}/${theme} (+${wide}px)`);
  if (save) { await page.screenshot({ path: `${OUT}/${name}-${width}-${theme}.png`, fullPage: width < 768 }); shots++; }
}

for (const theme of ['light', 'dark'] as const) {
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    await ctx.addCookies([{ name: 'vs-theme', value: theme, url: BASE }]);
    const page = await ctx.newPage();
    const save = FULL.has(width) || width === 320;
    for (const path of ['/login', '/signup', '/forgot-password']) {
      await page.goto(`${BASE}${path}`);
      await shoot(page, path.slice(1), width, theme, save && path === '/login');
    }
    await login(page, probe('s78a'));
    for (const [name, path] of [['dashboard', '/app?month=2026-09'], ['movements', '/app/movimientos?month=2026-09'], ['review', '/app/revisar'], ['more', '/app/mas']] as const) {
      await page.goto(`${BASE}${path}`);
      await shoot(page, name, width, theme, save);
    }
    await page.goto(`${BASE}/app/movimientos?month=2026-09&q=TIENDA`);
    await page.getByText('TIENDA RARA E2E').first().click();
    await page.waitForURL(/movimientos\/[0-9a-f-]{36}$/);
    await shoot(page, 'detail', width, theme, save);
    await page.getByRole('button', { name: 'Dividir gasto' }).click();
    const sheet = page.getByTestId('split-sheet');
    await sheet.waitFor({ state: 'visible' });
    await shoot(page, 'split-empty', width, theme, save);
    const rows = sheet.getByTestId('split-row');
    await rows.nth(0).locator('select').selectOption({ label: 'Alimentación' });
    await rows.nth(0).locator('input[inputmode=decimal]').fill('1800');
    await rows.nth(1).locator('select').selectOption({ label: 'Ocio' });
    await rows.nth(1).locator('input[inputmode=decimal]').fill('900');
    await sheet.getByRole('button', { name: 'Añadir parte' }).click();
    await rows.nth(2).locator('select').selectOption({ label: 'Personal' });
    await rows.nth(2).locator('input[inputmode=decimal]').fill('300');
    await shoot(page, 'split-filled', width, theme, save);
    await rows.nth(2).locator('input[inputmode=decimal]').fill('900');
    await shoot(page, 'split-invalid', width, theme, save);
    await ctx.close();
  }
}
await browser.close();
console.log(`visual: ${overflow.length ? 0 : 1}/1 passed (${shots} screenshots in ${OUT}; horizontal overflow: ${overflow.length ? overflow.join(', ') : 'none'})`);
process.exit(overflow.length ? 1 : 0);
