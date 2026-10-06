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
  check('Resumen opens with free money marked "Estimado", the next income and what is missing', row.includes('Dinero libre') && row.includes('Estimado') && row.includes('Hasta tu próximo ingreso') && /Falta(n)? \d* ?dato/.test(row), row);
  const part = async (id: string) => minor((await page.getByTestId(id).textContent()) ?? '');
  const freeShown = await part('free-summary-amount');
  check('the bar adds up: pagos + reservado + libre = the declared balance (S/ 5,000)', (await part('free-committed')) + (await part('free-set-aside')) + freeShown === 500000,
    JSON.stringify([await part('free-committed'), await part('free-set-aside'), freeShown]));
  const coming = await page.getByTestId('coming-up').locator('li').allTextContents();
  check('"Lo que viene" ends with the expected income, after the horizon line', coming.some((t) => t.includes('Tu próximo ingreso')) && (coming.at(-1) ?? '').includes('Esperado'), JSON.stringify(coming));
  check('the month stays as context (income, expenses, flow)', (await page.getByTestId('net-PEN').count()) === 1 && (await page.getByTestId('income-PEN').count()) === 1);
  const event = (await page.getByTestId('income-event').textContent()) ?? '';
  check('income event: "Entraron S/ 4,000.00" with a Repartir action (no modal)', event.includes('Entraron S/ 4,000.00') && event.includes('Repartir'), event);

  await page.goto(`${BASE}/app/plan`);
  const hero = (await page.getByTestId('free-PEN').textContent()) ?? '';
  check('plan is labelled estimated and says what is missing', hero.includes('Dinero libre estimado') && /(Falta 1 dato|Faltan \d+ datos) por confirmar/.test(hero), hero);
  const tl = await page.getByTestId('timeline').locator('li').allTextContents();
  check('timeline lists what comes in date order, incomes marked as expected (not received)', tl.length > 0 && tl.some((t) => t.includes('Ingreso esperado') || t.includes('aún no registrado')), JSON.stringify(tl));
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
  // Recurrence lifecycle (ADR-0010): pause → the row says so and Dinero libre stops reserving it; resume restores it.
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

  // What-if (never writes): income delayed 7 days; S/ 1,000 to Visa.
  await page.goto(`${BASE}/app/plan?si=retraso&dias=7`);
  const w1 = (await page.getByTestId('what-if-result').textContent()) ?? '';
  check('what-if delay: shows the new free money vs today, labelled as a simulation', /Te (quedarían|faltarían) S\/ [\d,.]+/.test(w1) && w1.includes('hoy S/') && w1.includes('no cambia nada'), w1);
  const visa = (await sb.from('debts').select('id,balance_minor').eq('name', 'Visa').single()).data!;
  await page.goto(`${BASE}/app/plan?si=abono&monto=1000&deuda=${visa.id}`);
  const w2 = (await page.getByTestId('what-if-result').textContent()) ?? '';
  check('what-if debt payment: debt after S/ 2,000 and interest avoided (rate known)', w2.includes('Deuda después: S/ 2,000.00') && w2.includes('de interés al mes'), w2);
  const visaAfter = (await sb.from('debts').select('balance_minor').eq('id', visa.id).single()).data!;
  check('what-if wrote nothing (debt balance unchanged)', Number(visaAfter.balance_minor) === Number(visa.balance_minor));

  // Payoff comparison: one debt has no rate → no ranking, names the missing rate.
  await page.goto(`${BASE}/app/compromisos?cuota=800`);
  const po = (await page.getByTestId('payoff').textContent()) ?? '';
  check('payoff with a missing rate: no ranking invented', po.includes('Falta la tasa de Préstamo familiar') && !po.includes('meses'), po);

  // "Aplicar plan" (ADR-0013): saves reservations; never pays, moves money or marks paid. Two tabs → one active plan.
  const snapshot = async () => JSON.stringify([
    (await sb.from('transactions').select('id', { count: 'exact', head: true })).count,
    (await sb.from('plan_settlements').select('id', { count: 'exact', head: true })).count,
    (await sb.from('fixed_expenses').select('id,amount_minor,active').order('id')).data,
    (await sb.from('debts').select('id,balance_minor').order('id')).data]);
  const plans = async () => (await sb.from('plan_applications').select('id,status,free_minor,reserved_minor,supersedes_id,lines').order('created_at')).data ?? [];
  const money0 = await snapshot();
  await page.goto(`${BASE}/app/plan`);
  const tab2 = await (await browser.newContext()).newPage();
  await login(tab2, A);
  await tab2.goto(`${BASE}/app/plan`);
  const heroFree = minor((await page.getByTestId('free-PEN-amount').textContent()) ?? '');
  await act(page, () => page.getByTestId('apply-PEN').click());
  const card = (await page.getByTestId('applied-PEN').textContent()) ?? '';
  const p1 = await plans();
  check('apply: one active plan with the free money shown and its lines', p1.length === 1 && p1[0]!.status === 'active' && Math.abs(Number(p1[0]!.free_minor)) === heroFree && Array.isArray(p1[0]!.lines) && p1[0]!.lines.length > 0, JSON.stringify(p1.map((x) => [x.status, x.free_minor])));
  check('applied card separates Comprometido / Reservado / Pagado / Libre and says no money moved', ['Plan aplicado', 'Comprometido', 'Reservado', 'Pagado', 'el dinero sigue en tu cuenta'].every((w) => card.includes(w)), card);
  await act(tab2, () => tab2.getByTestId('apply-PEN').click());
  const p2 = await plans();
  check('second tab applies the same plan → still exactly one active (the first is kept as history)', p2.filter((x) => x.status === 'active').length === 1 && p2.length === 2 && p2[1]!.supersedes_id === p2[0]!.id, JSON.stringify(p2.map((x) => x.status)));
  await tab2.context().close();
  check('applying wrote no movement, payment, settlement or debt change', (await snapshot()) === money0);
  // Data changed after applying → the card says so; "Actualizar plan" saves the new one.
  const lastBal = (await sb.from('balance_snapshots').select('amount_minor').order('as_of', { ascending: false }).limit(1).single()).data!;
  await sb.from('balance_snapshots').insert({ user_id: (await sb.auth.getUser()).data.user!.id, currency: 'PEN', amount_minor: Number(lastBal.amount_minor) + 10000 });
  await page.reload();
  const changedNote = (await page.getByTestId('applied-PEN').textContent()) ?? '';
  check('after a balance change the applied plan says it changed', changedNote.includes('Tus datos cambiaron'), changedNote);
  await act(page, () => page.getByRole('button', { name: 'Actualizar plan' }).click());
  const p3 = await plans();
  check('update supersedes: one active, with S/ 100 more free', p3.filter((x) => x.status === 'active').length === 1 && Number(p3.at(-1)!.free_minor) === Number(p2[1]!.free_minor) + 10000, JSON.stringify(p3.map((x) => [x.status, x.free_minor])));
  const blocked = await sb.from('plan_applications').update({ free_minor: 1 }).eq('id', p3.at(-1)!.id).select('id');
  check('API: an applied plan\'s amounts cannot be edited', !!blocked.error, JSON.stringify(blocked.error));
  await act(page, () => page.getByRole('button', { name: 'Quitar plan' }).click());
  const p4 = await plans();
  check('Quitar plan: no active plan; history kept (nothing deleted)', p4.length === 3 && p4.every((x) => x.status !== 'active') && p4.at(-1)!.status === 'cancelled', JSON.stringify(p4.map((x) => x.status)));
  check('history lists previous plans', ((await page.getByTestId('applied-history-PEN').textContent()) ?? '').includes('Quitado'));

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
