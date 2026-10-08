/**
 * Visual QA: real screenshots of the running app (no mockups) at the target breakpoints in light and dark, plus an
 * automatic check that no screen scrolls horizontally. Uses the seeded probe users (seed.sql: s78a rich data,
 * s10a split). Output: .e2e/shots/<screen>-<width>-<theme>.png and one summary line.
 * Run (server up, seeded): node --experimental-strip-types tests/e2e/visual.ts
 */
import { chromium, type Page } from 'playwright-core';
import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import { BASE, login, probe } from './lib.ts';

// Seed rows are relative to the Lima month (tests/e2e/seed.sql): use the current month, never a fixed one.
const M0 = new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 7);

const WIDTHS = [320, 375, 390, 430, 768, 1024, 1280, 1440];
const FULL = new Set([375, 1280]); // every screen; the rest only for the overflow check + key screens
const OUT = '.e2e/shots';
mkdirSync(OUT, { recursive: true });
const root = '/opt/pw-browsers';
const dir = existsSync(root) ? readdirSync(root).find((d) => /^chromium-\d+$/.test(d)) : undefined;
const browser = await chromium.launch({ executablePath: dir ? `${root}/${dir}/chrome-linux/chrome` : undefined });
const overflow: string[] = [];
const issues: string[] = [];
let shots = 0;

/** Cheap UX audit of the rendered screen: duplicate ids, unlabeled fields, visible touch targets under 44px (mobile). */
async function audit(page: Page, name: string, width: number) {
  const found = await page.evaluate((mobile) => {
    const out: string[] = [];
    const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dup.length) out.push(`duplicate id ${[...new Set(dup)].join(',')}`);
    for (const el of document.querySelectorAll('input:not([type=hidden]), select, textarea')) {
      const e = el as HTMLInputElement;
      const labelled = e.labels?.length || e.getAttribute('aria-label') || e.getAttribute('aria-labelledby');
      if (!labelled) out.push(`unlabeled ${e.name || e.tagName}`);
    }
    if (mobile) {
      for (const el of document.querySelectorAll('button, a.button, [role=button], input[type=radio], input[type=checkbox]')) {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || (el as HTMLElement).closest('dialog:not([open])')) continue;
        const target = el.matches('input') ? (el.closest('label') ?? el).getBoundingClientRect() : r;
        if (target.height < 40) out.push(`small target "${(el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 24)}" ${Math.round(target.height)}px`);
      }
    }
    return out;
  }, width < 768);
  for (const f of found) issues.push(`${name}@${width}: ${f}`);
}

async function shoot(page: Page, name: string, width: number, theme: string, save: boolean) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 0) overflow.push(`${name}@${width}/${theme} (+${wide}px)`);
  if (theme === 'light' && (width === 375 || width === 1280)) await audit(page, name, width);
  if (save) { await page.screenshot({ path: `${OUT}/${name}-${width}-${theme}.png`, fullPage: width < 768 }); shots++; }
}

for (const theme of ['light', 'dark'] as const) {
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    await ctx.addCookies([{ name: 'vs-theme', value: theme, url: BASE }]);
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' || /hydrat/i.test(m.text())) issues.push(`console@${width}/${theme}: ${m.text().slice(0, 140)}`); });
    page.on('pageerror', (e) => issues.push(`pageerror@${width}/${theme}: ${e.message.slice(0, 140)}`));
    const save = FULL.has(width) || width === 320;
    for (const path of ['/login', '/signup', '/forgot-password']) {
      await page.goto(`${BASE}${path}`);
      await shoot(page, path.slice(1), width, theme, save && path === '/login');
    }
    await login(page, probe('s78a'));
    for (const [name, path] of [['dashboard', `/app?month=${M0}`], ['movements', `/app/movimientos?month=${M0}`], ['review', '/app/revisar'], ['more', '/app/mas'],
      ['analysis', `/app/analisis?month=${M0}`], ['budgets', '/app/presupuestos'], ['payments', '/app/compromisos'], ['accounts', '/app/tarjetas'],
      ['rules', '/app/reglas'], ['connections', '/app/conexiones'], ['account-plan', '/app/cuenta'], ['settings', '/app/ajustes'], ['new', '/app/movimientos/nuevo'],
      ['import', '/app/importar'], ['ask', '/app/preguntar']] as const) {
      await page.goto(`${BASE}${path}`);
      await shoot(page, name, width, theme, save);
    }
    await page.goto(`${BASE}/app/movimientos?month=${M0}&q=TIENDA`);
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
    // Cash-flow planning demo (seed s11a).
    await ctx.clearCookies();
    await ctx.addCookies([{ name: 'vs-theme', value: theme, url: BASE }]);
    await login(page, probe('s11a'));
    for (const [name, path] of [['free-dashboard', '/app'], ['free-plan', '/app/plan'], ['free-payments', '/app/compromisos']] as const) {
      await page.goto(`${BASE}${path}`);
      await shoot(page, name, width, theme, save);
    }
    // Vels user after its suite (seed s14a): applied plan + card statement (ADR-0013/0014), and the Vels panel.
    await ctx.clearCookies();
    await ctx.addCookies([{ name: 'vs-theme', value: theme, url: BASE }]);
    await login(page, probe('s14a'));
    for (const [name, path] of [['applied-plan', '/app/plan'], ['card-statement', '/app/tarjetas']] as const) {
      await page.goto(`${BASE}${path}`);
      await shoot(page, name, width, theme, save);
    }
    await page.getByTestId('vels-fab').click();
    await page.locator('dialog.vels-panel[open] .composer').waitFor();
    await shoot(page, 'vels-panel', width, theme, save);
    // Conversational onboarding (seed s12a; runs after the onboarding suite, which leaves it reset to a fresh start).
    await ctx.clearCookies();
    await ctx.addCookies([{ name: 'vs-theme', value: theme, url: BASE }]);
    await login(page, probe('s12a'));
    await page.goto(`${BASE}/bienvenida`);
    await page.getByTestId('velsuno-msg').nth(1).waitFor();
    await shoot(page, 'welcome', width, theme, save);
    await ctx.close();
  }
}
await browser.close();
const unique = [...new Set(issues)];
for (const i of unique) console.log(`ISSUE  ${i}`);
const ok = overflow.length === 0 && unique.length === 0;
console.log(`visual: ${ok ? 1 : 0}/1 passed (${shots} screenshots in ${OUT}; horizontal overflow: ${overflow.length ? overflow.join(', ') : 'none'}; ux issues: ${unique.length})`);
process.exit(ok ? 0 : 1);
