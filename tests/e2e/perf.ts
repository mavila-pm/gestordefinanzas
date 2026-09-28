/**
 * Interaction latency probe (not a pass/fail suite for speed; it records numbers). Mobile 390px, seed user s11a.
 * For each interaction: time to first visible feedback, and time until the result is on screen.
 * Checks only guard the UX contract: something visible changes within 100 ms of the tap.
 * Run: scripts/e2e.sh perf
 */
import type { Page } from 'playwright-core';
import { BASE, login, probe, runSuite } from './lib.ts';

const A = probe('s11a');
const now = () => performance.now();

/**
 * Latency measured inside the page: from the tap's pointerdown (window.__t0, set in capture phase) to the first
 * animation frame where `fn` holds. Playwright's own actionability waits are not counted.
 */
async function until(page: Page, _t0: number, fn: string, timeout = 15000): Promise<number> {
  const h = await page.waitForFunction(`(${fn}) ? Math.round(performance.now() - (window.__t0 ?? performance.now())) : false`, undefined, { timeout, polling: 'raf' });
  return (await h.jsonValue()) as number;
}
const arm = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __t0?: number; __armed?: boolean };
  if (!w.__armed) { w.__armed = true; addEventListener('pointerdown', () => { w.__t0 = performance.now(); }, true); }
});

await runSuite('perf', async ({ page, check }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, A);
  const rows: string[] = [];
  const log = (what: string, feedback: number, done: number) => { rows.push(`PERF ${what.padEnd(34)} feedback ${String(feedback).padStart(5)} ms   done ${String(done).padStart(5)} ms`); };

  // Tab navigation (bottom nav): feedback = pressed/loading state or new page; done = new page heading.
  for (const [label, path] of [['Movimientos', '/app/movimientos'], ['Revisar', '/app/revisar'], ['Resumen', '/app'], ['Más', '/app/mas']] as const) {
    await page.waitForLoadState('networkidle'); await arm(page);
    const link = page.locator(`nav.bottom-nav a[href="${path}"], nav.bottom-nav a[href^="${path}?"]`).first();
    const t0 = now();
    await link.click();
    const fb = await until(page, t0, `location.pathname === '${path}' || !!document.querySelector('[data-nav-pending], .route-loading')`);
    const done = await until(page, t0, `location.pathname === '${path}' && !document.querySelector('.route-loading')`);
    log(`nav → ${label}`, fb, done);
    check(`nav ${label}: visible feedback < 100 ms`, fb < 100, String(fb));
  }

  // Dinero libre and Próximos pagos from Más.
  for (const path of ['/app/plan', '/app/compromisos']) {
    await page.goto(`${BASE}/app/mas`);
    await page.waitForLoadState('networkidle'); await arm(page);
    const t0 = now();
    await page.locator(`main a[href="${path}"]`).first().click();
    const fb = await until(page, t0, `location.pathname === '${path}' || !!document.querySelector('[data-nav-pending], .route-loading')`);
    const done = await until(page, t0, `location.pathname === '${path}' && !document.querySelector('.route-loading') && !!document.querySelector('main h1')`);
    log(`nav → ${path}`, fb, done);
    check(`nav ${path}: visible feedback < 100 ms`, fb < 100, String(fb));
  }

  // Sheet open (client only) + save balance (server action).
  await page.goto(`${BASE}/app/plan`);
  await page.waitForLoadState('networkidle'); await arm(page);
  const trigger = page.getByRole('button', { name: /saldo/i }).first();
  if (await trigger.count()) {
    let t0 = now();
    await trigger.click();
    const open = await until(page, t0, `!!document.querySelector('dialog[open]')`);
    log('sheet open (saldo)', open, open);
    const dialog = page.locator('dialog[open]');
    await dialog.locator('input[name=amount]').fill('5000');
    t0 = now();
    await dialog.locator('button[type=submit]').click();
    const fb = await until(page, t0, `!!document.querySelector('dialog[open] form[aria-busy=true]') || !document.querySelector('dialog[open]')`);
    const done = await until(page, t0, `!document.querySelector('dialog[open]')`);
    log('save balance (server action)', fb, done);
    check('save: busy state < 100 ms', fb < 100, String(fb));
  }

  // Preguntar: sent message visible, then answer.
  await page.goto(`${BASE}/app/preguntar`);
  await page.waitForLoadState('networkidle'); await arm(page);
  const users = await page.getByTestId('user-msg').count();
  const velsuno = await page.getByTestId('velsuno-msg').count();
  await page.fill('#chat-text', '¿Cuánto tengo libre?');
  const t0 = now();
  await page.locator('.composer button[type=submit]').click();
  const shown = await until(page, t0, `document.querySelectorAll('[data-testid=user-msg]').length > ${users}`);
  const answered = await until(page, t0, `document.querySelectorAll('[data-testid=velsuno-msg]').length > ${velsuno}`);
  log('Preguntar send', shown, answered);
  check('Preguntar: sent message visible < 100 ms', shown < 100, String(shown));

  console.log(rows.join('\n'));
});
