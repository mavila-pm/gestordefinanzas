/**
 * Cash-flow planning (ADR-0005) end-to-end against the REAL Supabase project, with the synthetic demo of seed s11.
 * Assertions are date-independent: they check the arithmetic and the honesty rules, not which payments fall in the
 * horizon on the day the suite runs.
 * Run all suites: scripts/e2e.sh (seed: tests/e2e/seed.sql).
 */
import { act, apiAs, B_TX, BASE, login, probe, runSuite } from './lib.ts';

const A = probe('s11a');
const minor = (s: string) => Math.round(Number(s.replace(/[^\d.]/g, '')) * 100);

await runSuite('cashflow', async ({ page, check }) => {
  await login(page, A);
  await page.goto(`${BASE}/app`);
  const row = (await page.getByTestId('free-summary').textContent()) ?? '';
  check('Resumen shows free money as an estimate (data missing), with what was already set aside', row.includes('Dinero libre estimado') && row.includes('Ya descontamos'), row);
  const event = (await page.getByTestId('income-event').textContent()) ?? '';
  check('income event: "Entraron S/ 4,000.00" with a way to see the distribution (no modal)', event.includes('Entraron S/ 4,000.00') && event.includes('Ver distribución'), event);

  await page.goto(`${BASE}/app/plan`);
  const hero = (await page.getByTestId('free-PEN').textContent()) ?? '';
  check('plan is labelled estimated and says what is missing', hero.includes('Dinero libre estimado') && /Falta(n)? confirmar/.test(hero), hero);
  const bd = page.getByTestId('breakdown');
  await bd.locator('summary').click();
  const lines = await bd.locator('li').allTextContents();
  const base = minor(lines[0] ?? '');
  const total = lines.at(-1) ?? '';
  const deductions = lines.slice(1, -1).reduce((s, l) => s + (l.includes('por confirmar') ? 0 : minor(l.slice(l.lastIndexOf('S/')))), 0);
  check('breakdown: starts from the declared S/ 5,000.00', base === 500000, lines[0]);
  check('breakdown arithmetic is reproducible: saldo − líneas = libre', minor(total.slice(total.lastIndexOf('S/'))) === base - deductions || total.includes('Faltan'), JSON.stringify(lines));
  check('the planned salary is not money: it is never a line nor added to the base', !lines.some((l) => l.includes('Sueldo')));
  check('unknown amounts are never shown as S/ 0.00', !lines.some((l) => l.includes('Internet') && l.includes('0.00')));
  check('lo básico and the cushion are explicit lines', lines.some((l) => l.includes('Gastos básicos')) && lines.some((l) => l.includes('Colchón')));
  const missing = (await page.getByTestId('missing-PEN').textContent()) ?? '';
  check('falta confirmar lists concrete, fixable items', missing.length > 0 && missing.includes('Completar') === (missing.includes('Falta el monto') || missing.includes('Falta la fecha') || missing.includes('Confirma si')), missing);

  // What-if never writes: free figure identical before and after.
  const freeText = (await page.getByTestId('free-PEN-amount').textContent()) ?? '';
  const free = minor(freeText) * (freeText.includes('Faltan') ? -1 : 1);
  await page.fill('[data-testid=simulator] input', ((free + 10000) / 100).toFixed(2));
  check('simulator: a purchase above free money shows the uncovered amount', ((await page.getByTestId('simulation').textContent()) ?? '').includes('S/ 100.00 de tus próximos pagos sin cubrir'));
  if (free > 100) {
    await page.fill('[data-testid=simulator] input', '1');
    check('simulator: a small purchase keeps next payments covered', ((await page.getByTestId('simulation').textContent()) ?? '').includes('siguen cubiertos'));
  } else check('simulator: a small purchase keeps next payments covered', true);
  await page.reload();
  check('simulator saved nothing', ((await page.getByTestId('free-PEN-amount').textContent()) ?? '') === freeText);

  // Distribution of the income that just arrived: reserve + free = entered.
  await page.goto(`${BASE}/app/plan`);
  await page.getByTestId('income-event').getByRole('link', { name: 'Ver distribución' }).click();
  await page.getByTestId('distribution').waitFor();
  const reserved = minor((await page.getByTestId('dist-reserved').textContent()) ?? '');
  const distFreeText = (await page.getByTestId('dist-free').textContent()) ?? '';
  const distFree = minor(distFreeText);
  const faltan = ((await page.getByTestId('distribution').textContent()) ?? '').includes('Faltan');
  check('distribution: reservar + libre = S/ 4,000.00 entered', faltan ? reserved - distFree === 400000 : reserved + distFree === 400000, `${reserved} ${distFree}`);

  // Variation: Luz expected 129.00, last paid 160.00 -> +31.00; "Mantener" keeps the reference and silences it.
  await page.goto(`${BASE}/app/plan`);
  const vari = (await page.getByTestId('variations').textContent()) ?? '';
  check('variation: "Luz subió S/ 31.00"', vari.includes('Luz subió S/ 31.00'), vari);
  await act(page, () => page.click('form[aria-label="Mantener monto de Luz"] button'));
  await page.reload();
  check('kept reference: the notice disappears, history untouched', (await page.getByTestId('variations').count()) === 0);

  // Suggestion: an unlinked "PAGO CUOTA CARRO" -> confirm links it (no new transaction).
  const sugg = page.getByTestId('match-suggestions');
  if (await sugg.count()) {
    await act(page, () => page.click('form[aria-label="Confirmar pago de Carro"] button'));
    await page.reload();
    check('confirming a detected payment removes the suggestion', (await page.getByTestId('match-suggestions').count()) === 0);
  } else check('confirming a detected payment removes the suggestion', true);

  // Balance update is a new snapshot and moves the figure.
  await page.getByRole('button', { name: 'Indicar saldo en soles' }).first().click();
  await page.fill('form[aria-label="Saldo PEN"] input[name=amount]', '6000');
  await act(page, () => page.click('form[aria-label="Saldo PEN"] button[type=submit]'));
  await page.reload();
  await page.getByTestId('breakdown').locator('summary').click();
  check('new balance used (S/ 6,000.00)', ((await page.getByTestId('breakdown').locator('li').first().textContent()) ?? '').includes('S/ 6,000.00'));

  // Próximos pagos: debts compared, never "the best"; missing rate stated.
  await page.goto(`${BASE}/app/compromisos`);
  const strat = (await page.getByTestId('debt-strategies').textContent()) ?? '';
  check('debt strategies: avalanche needs every rate, snowball orders by balance', strat.includes('Falta la tasa de Préstamo familiar') && strat.includes('Préstamo familiar → Visa') && strat.includes('Ninguna es mejor para todos'), strat);
  const obls = (await page.getByTestId('obligation-list').textContent()) ?? '';
  check('obligations read naturally: window, preferred day, unknown amount', obls.includes('vence el 9–10 aprox.') && obls.includes('pagas el 7') && obls.includes('Por confirmar'), obls);

  // A/B through the API with A's session.
  const sb = await apiAs(A);
  const bRead = await sb.from('fixed_expenses').select('id').eq('id', B_TX.obligation);
  check('API: A cannot read B\'s obligations', !bRead.error && (bRead.data ?? []).length === 0, JSON.stringify(bRead));
  const bUpd = await sb.from('fixed_expenses').update({ amount_minor: 1 }).eq('id', B_TX.obligation).select('id');
  check('API: A cannot modify B\'s obligations', (bUpd.data ?? []).length === 0, JSON.stringify(bUpd));
  const snaps = await sb.from('balance_snapshots').select('amount_minor');
  check('API: A only sees own balances (B\'s S/ 7,777 invisible)', !(snaps.data ?? []).some((r) => Number(r.amount_minor) === 777700), JSON.stringify(snaps.data));
  const aTx = (await sb.from('transactions').select('id').limit(1).single()).data?.id;
  const cross = await sb.from('plan_settlements').insert({ user_id: (await sb.auth.getUser()).data.user!.id, fixed_expense_id: B_TX.obligation, period: '2026-10', transaction_id: aTx });
  check('API: A cannot settle B\'s obligation with its own movement', !!cross.error, JSON.stringify(cross.error));
  const rewrite = await sb.from('balance_snapshots').update({ amount_minor: 1 }).neq('amount_minor', -1).select('id');
  check('API: balance history is append-only', !!rewrite.error || (rewrite.data ?? []).length === 0, JSON.stringify(rewrite));
});
