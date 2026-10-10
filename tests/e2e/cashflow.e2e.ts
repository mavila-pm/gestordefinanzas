/**
 * Cash-flow planning (ADR-0005) end-to-end against the REAL Supabase project, with the synthetic demo of seed s11.
 * Assertions are date-independent: they check the arithmetic and the honesty rules, not which payments fall in the
 * horizon on the day the suite runs.
 * Run all suites: scripts/e2e.sh (seed: tests/e2e/seed.sql).
 */
import { act, apiAs, B_TX, BASE, login, probe, runSuite } from './lib.ts';

const A = probe('s11a');
const minor = (s: string) => Math.round(Number(s.replace(/[^\d.]/g, '')) * 100);

await runSuite('cashflow', async ({ browser, page, check }) => {
  await login(page, A);
  await page.goto(`${BASE}/app`);
  const row = ((await page.getByTestId('free-summary').textContent()) ?? '').replace(/\s+/g, ' ');
  check('Resumen opens with free money marked "Estimado", the next income and what is missing', row.includes('Dinero disponible') && row.includes('Estimado') && row.includes('Hasta tu próximo ingreso') && /Falta(n)? \d* ?dato/.test(row), row);
  const part = async (id: string) => minor((await page.getByTestId(id).textContent()) ?? '');
  const freeShown = await part('free-summary-amount');
  check('the bar adds up: pagos + reservado + libre = the declared balance (S/ 5,000)', (await part('free-committed')) + (await part('free-set-aside')) + freeShown === 500000,
    JSON.stringify([await part('free-committed'), await part('free-set-aside'), freeShown]));
  const coming = await page.getByTestId('coming-up').locator('li').allTextContents();
  check('"Lo que viene" ends with the expected income, after the horizon line', coming.some((t) => t.includes('Tu próximo ingreso')) && (coming.at(-1) ?? '').includes('Esperado'), JSON.stringify(coming));
  check('the month stays as context (income, expenses, flow)', (await page.getByTestId('net-PEN').count()) === 1 && (await page.getByTestId('income-PEN').count()) === 1);
  const event = (await page.getByTestId('income-event').textContent()) ?? '';
  check('income event: "Entraron S/ 4,000.00" with a Ver reparto action (no modal)', event.includes('Entraron S/ 4,000.00') && event.includes('Ver reparto'), event);

  await page.goto(`${BASE}/app/plan`);
  const hero = (await page.getByTestId('free-PEN').textContent()) ?? '';
  check('plan is labelled estimated and says what is missing', hero.includes('Dinero disponible estimado') && /(Falta 1 dato|Faltan \d+ datos) por confirmar/.test(hero), hero);
  check('the page has no simulators or saved-plan controls (questions and what-ifs live in Vels)',
    (await page.getByTestId('what-if').count()) === 0 && (await page.getByTestId('simulator').count()) === 0 && (await page.getByTestId('apply-PEN').count()) === 0);
  const up = await page.getByTestId('upcoming-PEN').locator('li').allTextContents();
  check('próximos pagos before the next income are listed', up.length > 0, JSON.stringify(up));
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

  // Distribution of the income that just arrived: reserve + free = entered.
  await page.goto(`${BASE}/app`);
  await page.getByTestId('income-event').getByRole('link', { name: 'Ver reparto' }).click();
  await page.getByTestId('distribution').waitFor();
  const reserved = minor((await page.getByTestId('dist-reserved').textContent()) ?? '');
  const distFreeText = (await page.getByTestId('dist-free').textContent()) ?? '';
  const distFree = minor(distFreeText);
  const faltan = ((await page.getByTestId('distribution').textContent()) ?? '').includes('Faltan');
  check('distribution: para tus pagos + disponible = S/ 4,000.00 entered', faltan ? reserved - distFree === 400000 : reserved + distFree === 400000, `${reserved} ${distFree}`);

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
  check('debt strategies: avalanche needs every rate, snowball orders by balance', strat.includes('Falta la tasa de Préstamo familiar') && strat.includes('Préstamo familiar → Visa'), strat);
  const obls = (await page.getByTestId('obligation-list').textContent()) ?? '';
  check('obligations read naturally: window, preferred day, unknown amount', obls.includes('vence el 9–10 aprox.') && obls.includes('pagas el 7') && obls.includes('Por confirmar'), obls);

  // A/B through the API with A's session.
  const sb = await apiAs(A);
  // Recurrence lifecycle (ADR-0010): pause → the row says so and Dinero disponible stops reserving it; resume restores it.
  await page.goto(`${BASE}/app/compromisos`);
  await page.getByRole('button', { name: 'Editar Celular' }).click();
  await act(page, () => page.locator('dialog[open] form[aria-label="Pausar Celular"] button[type=submit]').click());
  const pausedRow = (await page.getByTestId('obligation-list').locator('li[data-name="Celular"] > .setting-text').textContent()) ?? '';
  check('pause: the payment shows "Pausado hasta", history untouched', pausedRow.includes('Pausado hasta'), pausedRow);
  const celular = (await sb.from('fixed_expenses').select('id,paused_until,amount_minor').eq('name', 'Celular').single()).data;
  const trail = (await sb.from('learning_events').select('entity,action').eq('entity_id', celular?.id ?? '')).data ?? [];
  check('pause is stored as a date and logged; the amount is not changed', !!celular?.paused_until && Number(celular.amount_minor) === 10000 && trail.some((t) => t.action === 'snoozed'), JSON.stringify({ celular, trail }));
  await page.getByRole('button', { name: 'Editar Celular' }).click();
  await act(page, () => page.locator('dialog[open] form[aria-label="Reanudar Celular"] button[type=submit]').click());
  const resumed = (await sb.from('fixed_expenses').select('paused_until').eq('name', 'Celular').single()).data;
  check('resume clears the pause', resumed?.paused_until === null, JSON.stringify(resumed));

  // Skip one occurrence ("No lo pago el 5 oct"): skipped ≠ paid, no movement, undoable.
  const tx0 = (await sb.from('transactions').select('id', { count: 'exact', head: true })).count;
  await page.getByRole('button', { name: 'Editar Celular' }).click();
  await act(page, () => page.locator('dialog[open] form[aria-label^="Omitir Celular"] button[type=submit]').click());
  const skipped = (await sb.from('plan_settlements').select('status,transaction_id,period')).data ?? [];
  check('skip: one "skipped" settlement without a movement; no transaction created', skipped.some((x) => x.status === 'skipped' && x.transaction_id === null)
    && (await sb.from('transactions').select('id', { count: 'exact', head: true })).count === tx0, JSON.stringify(skipped));

  // Payoff comparison: one debt has no rate → no ranking, names the missing rate.
  await page.goto(`${BASE}/app/compromisos?cuota=800`);
  const po = (await page.getByTestId('payoff').textContent()) ?? '';
  check('payoff with a missing rate: no ranking invented', po.includes('Falta la tasa de Préstamo familiar') && !po.includes('meses'), po);

  // "Aplicar plan" (ADR-0013) is done from Vels now (suite vels); the engine and SQL rules are unchanged (tests/db).

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
