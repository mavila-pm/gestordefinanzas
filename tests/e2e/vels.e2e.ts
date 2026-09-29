/**
 * Vels (ADR-0011) end-to-end on the real project, seed pair s14: the floating bubble on every /app screen opens the
 * conversational interface of the SAME financial core. Simulations never write; confirmed actions write once.
 * Run: scripts/e2e.sh vels (seed: scripts/e2e.sh render-seed s14a s14b).
 */
import type { Page } from 'playwright-core';
import { act, apiAs, BASE, login, probe, runSuite } from './lib.ts';

const A = probe('s14a');
const panel = (page: Page) => page.getByTestId('vels-panel');
const lastVels = async (page: Page) => ((await panel(page).getByTestId('velsuno-msg').last().textContent()) ?? '').replace(/\s+/g, ' ');
async function say(page: Page, text: string) {
  await panel(page).locator('#chat-text').fill(text);
  await act(page, () => panel(page).locator('.composer button[type=submit]').click());
}
async function openVels(page: Page): Promise<number> {
  await page.evaluate(() => { (window as unknown as { __t0: number }).__t0 = 0; addEventListener('pointerdown', () => { (window as unknown as { __t0: number }).__t0 = performance.now(); }, { once: true, capture: true }); });
  await page.getByTestId('vels-fab').click();
  const h = await page.waitForFunction(() => document.querySelector('dialog.vels-panel[open]') ? Math.round(performance.now() - (window as unknown as { __t0: number }).__t0) : false, undefined, { polling: 'raf' });
  await panel(page).locator('.composer').waitFor();
  return (await h.jsonValue()) as number;
}

await runSuite('vels', async ({ page, check }) => {
  const sb = await apiAs(A);
  const debts = async () => (await sb.from('debts').select('name,balance_minor,active').order('name')).data ?? [];
  const settlements = async () => (await sb.from('plan_settlements').select('id')).data?.length ?? 0;
  const txs = async () => (await sb.from('transactions').select('id', { count: 'exact', head: true })).count;

  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, A);
  await page.goto(`${BASE}/app`);
  check('bubble visible on the dashboard, labelled "Hablar con Vels"', await page.getByRole('button', { name: 'Hablar con Vels' }).isVisible());
  const opened = await openVels(page);
  check('tap → panel open immediately (< 100 ms), before data', opened < 100, String(opened));
  const box = await panel(page).boundingBox();
  check('mobile: Vels opens full-screen', !!box && Math.round(box.width) === 390, JSON.stringify(box));
  const openers = await panel(page).getByTestId('vels-openers').locator('button').allTextContents();
  check('a few openers from the real state (max 3)', openers.length > 0 && openers.length <= 3, JSON.stringify(openers));
  await page.keyboard.press('Escape');
  check('Escape closes Vels; the page stays usable', !(await panel(page).isVisible()) && (await page.getByRole('navigation', { name: 'Principal' }).isVisible()));

  // Context of the screen only seeds the openers; answers come from the same core.
  await page.goto(`${BASE}/app/compromisos`);
  await openVels(page);
  const o2 = await panel(page).getByTestId('vels-openers').locator('button').allTextContents();
  check('in Próximos pagos, Vels offers "¿Qué pago primero?"', o2.includes('¿Qué pago primero?'), JSON.stringify(o2));

  await say(page, '¿Hasta cuánto puedo usar la tarjeta?');
  const lim = await lastVels(page);
  check('card: bank limit ≠ operating limit ("El banco te permite S/ 10,000. Para este ciclo, tu límite real es…")', lim.includes('El banco te permite S/ 10,000') && lim.includes('límite real es S/'), lim);

  const d0 = JSON.stringify(await debts()); const s0 = await settlements(); const t0 = await txs();
  await say(page, '¿Qué pasa si pago S/ 1,000 a la tarjeta?');
  const sim = await lastVels(page);
  check('simulation answers with the engine (debt after S/ 2,000)', sim.includes('Si pagas S/ 1,000 a Tarjeta BCP') && sim.includes('S/ 2,000'), sim);
  check('simulation writes nothing (debts, settlements, movements unchanged)', JSON.stringify(await debts()) === d0 && (await settlements()) === s0 && (await txs()) === t0);

  await say(page, 'Tengo que pagarle S/ 1,000 a mi pareja');
  const prop = await lastVels(page);
  check('planned ≠ paid: Vels proposes, marks it pending, writes nothing yet', prop.includes('Queda pendiente, no pagada') && JSON.stringify(await debts()) === d0, prop);
  await act(page, () => panel(page).getByRole('button', { name: 'Guardar' }).click());
  const after = await debts();
  check('confirmed → one debt with tu pareja, S/ 1,000 pending; no payment, no movement', after.filter((x) => x.name === 'Deuda con tu pareja' && Number(x.balance_minor) === 100000).length === 1
    && (await settlements()) === s0 && (await txs()) === t0, JSON.stringify(after));
  await say(page, 'Tengo que pagarle S/ 1,000 a mi pareja');
  await act(page, () => panel(page).getByRole('button', { name: 'Guardar' }).click());
  check('same confirmation again writes nothing more (idempotent)', (await debts()).filter((x) => x.name === 'Deuda con tu pareja').length === 1 && (await lastVels(page)).includes('Ya la tenía guardada'));

  // "Aplica el plan": proposal first (nothing saved), then one saved plan; the same card again saves nothing more.
  await say(page, 'Aplica el plan');
  const ap = await lastVels(page);
  const planRows = async () => (await sb.from('plan_applications').select('id,status')).data ?? [];
  check('Vels proposes the plan with what it reserves and says it moves no money; nothing saved yet', ap.includes('¿Lo aplico?') && ap.includes('No paga ni mueve dinero') && (await planRows()).length === 0, ap);
  const t1 = await txs(); const s1 = await settlements();
  await act(page, () => panel(page).getByRole('button', { name: 'Aplicar plan' }).last().click());
  check('confirmed → one active plan; no movement, no settlement', (await planRows()).filter((x) => x.status === 'active').length === 1 && (await txs()) === t1 && (await settlements()) === s1, await lastVels(page));
  await act(page, () => panel(page).getByRole('button', { name: 'Aplicar plan' }).first().click());
  check('same confirmation card again → still one plan row (idempotent)', (await planRows()).length === 1);

  await say(page, '¿Qué pago primero?');
  check('no cross-user data in answers', !(await panel(page).textContent() ?? '').includes('B deuda secreta'));

  // Same state for both interfaces: the dashboard shows what Vels saved; reload keeps the conversation.
  await page.keyboard.press('Escape');
  await page.reload();
  check('the visual interface shows the debt Vels saved', ((await page.locator('main').textContent()) ?? '').includes('Deuda con tu pareja'));
  await openVels(page);
  check('reload keeps the conversation', ((await panel(page).textContent()) ?? '').includes('Tengo que pagarle S/ 1,000 a mi pareja'));
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${BASE}/app/plan`);
  await openVels(page);
  const db = await panel(page).boundingBox();
  check('desktop: floating panel (not full screen), bottom-right', !!db && db.width <= 420 && db.x > 600, JSON.stringify(db));
  await page.getByRole('button', { name: 'Cerrar' }).last().click();
  check('close button closes the panel', !(await panel(page).isVisible()));
  // Card cycle saved in the visual interface → Vels uses it (one core, two views).
  await page.goto(`${BASE}/app/tarjetas`);
  await page.getByRole('button', { name: 'Ciclo de Tarjeta BCP' }).click();
  const cyc = page.locator('dialog[open] form[aria-label="Ciclo de Tarjeta BCP"]');
  await cyc.locator('input[name=statementDay]').fill('23');
  await cyc.locator('input[name=paymentDay]').fill('19');
  await act(page, () => cyc.locator('button[type=submit]').click());
  const saved = (await sb.from('cards').select('statement_day,payment_day,credit_limit_minor').single()).data;
  check('card cycle saved on the person\'s card (limit kept)', saved?.statement_day === 23 && saved?.payment_day === 19 && Number(saved?.credit_limit_minor) === 1000000, JSON.stringify(saved));
  await openVels(page);
  await say(page, '¿Hasta cuánto puedo usar la tarjeta?');
  const cy = await lastVels(page);
  check('Vels reasons by cycle: when the billed amount is due and when today\'s purchase is paid', cy.includes('Lo facturado vence') && cy.includes('Lo que compres hoy') && cy.includes('se paga el'), cy);
  await page.keyboard.press('Escape');

  // Statement entered by hand (ADR-0014): billed / minimum / due; Tarjetas and Vels read the same numbers.
  await page.goto(`${BASE}/app/tarjetas`);
  await page.getByRole('button', { name: 'Estado de cuenta de Tarjeta BCP' }).click();
  const stf = page.locator('dialog[open] form[aria-label="Estado de cuenta de Tarjeta BCP"]');
  const today = new Date(Date.now() - 5 * 3600_000); const iso = (d: Date) => d.toISOString().slice(0, 10);
  const cut = iso(new Date(today.getTime() - 3 * 86_400_000)); const due = iso(new Date(today.getTime() + 20 * 86_400_000));
  await stf.locator('input[name=cutDate]').fill(cut);
  await stf.locator('input[name=dueDate]').fill(due);
  await stf.locator('input[name=billed]').fill('3000');
  await stf.locator('input[name=minimum]').fill('150');
  await act(page, () => stf.locator('button[type=submit]').click());
  // Saving the same cut again is a correction, never a second statement.
  await page.getByRole('button', { name: 'Estado de cuenta de Tarjeta BCP' }).click();
  await act(page, () => stf.locator('button[type=submit]').click());
  const sts = (await sb.from('card_statements').select('billed_minor,minimum_minor,used_minor,source')).data ?? [];
  check('statement saved once: billed S/ 3,000, minimum S/ 150, used unknown (null, not 0), manual', sts.length === 1 && Number(sts[0]!.billed_minor) === 300000 && Number(sts[0]!.minimum_minor) === 15000 && sts[0]!.used_minor === null && sts[0]!.source === 'manual', JSON.stringify(sts));
  const pos = ((await page.getByTestId('card-position').first().textContent()) ?? '').replace(/\s+/g, ' ');
  check('Tarjetas shows billed + due, minimum-only carry with interest, and when today\'s purchase is paid', pos.includes('Facturado S/ 3,000.00') && pos.includes('pasan S/ 2,850.00 al próximo ciclo') && pos.includes('Lo que compres hoy se paga el'), pos);
  await openVels(page);
  await say(page, '¿Hasta cuánto puedo usar la tarjeta?');
  const cl = await lastVels(page);
  check('Vels uses the statement: billed + due date, limit real ≠ bank line', cl.includes('Facturado') && cl.includes('S/ 3,000') && cl.includes('límite real es'), cl);
  await say(page, '¿Pago el mínimo?');
  const pm = await lastVels(page);
  check('Vels minimum vs total uses the billed amount and its due date', pm.includes('S/ 3,000') && /hasta el \d+ \w+/.test(pm), pm);
  await page.keyboard.press('Escape');

  await page.goto(`${BASE}/app/preguntar`);
  check('Vels page (existing route) says Vels and has no second bubble', ((await page.locator('h1').textContent()) ?? '') === 'Vels' && (await page.getByTestId('vels-fab').count()) === 0);
});
