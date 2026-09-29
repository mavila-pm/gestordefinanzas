/**
 * Received ↔ expected income (ADR-0007/0008) end-to-end on the real project, seed pair s13 (date-independent):
 * salary expected in 3 days paid early yesterday; two equal bonuses + one deposit; a USD income and a PEN deposit of
 * the same number. Nothing links by itself; the person confirms, picks or dismisses.
 * Run: scripts/e2e.sh income-link (seed: scripts/e2e.sh render-seed s13a s13b).
 */
import { act, apiAs, BASE, login, probe, runSuite } from './lib.ts';

const A = probe('s13a');
const B_INCOME = '00000000-0000-4000-8000-00000000e13b';
const MON = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'set', 'oct', 'nov', 'dic'];
const limaDay = (offset: number) => new Date(Date.now() - 5 * 3600_000 + offset * 86_400_000).toISOString().slice(0, 10);
const short = (d: string) => `${Number(d.slice(8, 10))} ${MON[Number(d.slice(5, 7)) - 1]}`;

await runSuite('income-link', async ({ page, check }) => {
  const sb = await apiAs(A);
  const settlements = async () => (await sb.from('plan_settlements').select('expected_income_id,period,transaction_id').not('expected_income_id', 'is', null)).data ?? [];
  const incomes = async () => JSON.stringify((await sb.from('expected_incomes').select('name,currency,amount_minor,day_of_month,active').order('name')).data);
  const txCount = async () => (await sb.from('transactions').select('id', { count: 'exact', head: true })).count;

  await login(page, A);
  await page.goto(`${BASE}/app/plan`);
  const expected = short(limaDay(3));
  const hero0 = (await page.getByTestId('free-PEN').textContent()) ?? '';
  check('before linking, the horizon is the expected salary (in 3 days)', hero0.includes(`próximo ingreso, el ${expected}`), hero0);

  const rows = page.getByTestId('income-match');
  const texts = await rows.allTextContents();
  check('salary deposit is suggested (not linked): "Parece tu sueldo"', texts.some((t) => t.includes('Parece tu sueldo') && t.includes('S/ 4,000')), JSON.stringify(texts));
  check('equal bonuses: the person must choose which one', texts.some((t) => t.includes('¿Cuál ingreso es?') && t.includes('Es bono a') && t.includes('Es bono b')), JSON.stringify(texts));
  check('PEN deposit never matches the USD income of the same number', texts.length === 2 && !texts.some((t) => /freelance/i.test(t) || t.includes('S/ 1,000')), JSON.stringify(texts));
  check('no auto-link: nothing settled just by viewing', (await settlements()).length === 0);

  const incomes0 = await incomes();
  const tx0 = await txCount();
  const bonus = rows.filter({ hasText: '¿Cuál ingreso es?' });
  await act(page, () => bonus.getByRole('button', { name: 'No es ese' }).click());
  check('"No es ese" hides the suggestion', (await page.getByTestId('income-match').filter({ hasText: '¿Cuál ingreso es?' }).count()) === 0);
  const decisions = (await sb.from('suggestion_decisions').select('kind,decision')).data ?? [];
  check('…and only records the decision: incomes, movements and settlements unchanged',
    (await incomes()) === incomes0 && (await txCount()) === tx0 && (await settlements()).length === 0 && decisions.some((d) => d.kind === 'income_match' && d.decision === 'dismissed'),
    JSON.stringify(decisions));

  const salary = page.getByTestId('income-match').filter({ hasText: 'Parece tu sueldo' });
  await act(page, () => salary.getByRole('button', { name: 'Sí, es ese' }).click());
  const linked = await settlements();
  const salaryId = (await sb.from('expected_incomes').select('id').eq('name', 'Sueldo').single()).data?.id;
  const salaryTx = (await sb.from('transactions').select('id').eq('merchant_raw', 'SUELDO E2E').single()).data?.id;
  check('"Sí, es ese" links exactly that deposit to that income', linked.length === 1 && linked[0]!.expected_income_id === salaryId && linked[0]!.transaction_id === salaryTx, JSON.stringify(linked));
  await page.goto(`${BASE}/app/plan`);
  const hero1 = (await page.getByTestId('free-PEN').textContent()) ?? '';
  check('the horizon moves to the following income (the received one no longer closes it)', hero1.includes('próximo ingreso, el') && !hero1.includes(`próximo ingreso, el ${expected}`), hero1);
  check('the linked deposit is no longer suggested', !((await page.getByTestId('income-match').allTextContents()).some((t) => t.includes('Parece tu sueldo'))));
  check('incomes and movements still unchanged after linking (expected ≠ received, nothing rewritten)', (await incomes()) === incomes0 && (await txCount()) === tx0);

  const again = await sb.from('plan_settlements').insert({ user_id: (await sb.auth.getUser()).data.user!.id, expected_income_id: salaryId, period: linked[0]!.period, transaction_id: salaryTx });
  check('idempotent: the same occurrence cannot be settled twice', !!again.error, JSON.stringify(again.error));
  const cross = await sb.from('plan_settlements').insert({ user_id: (await sb.auth.getUser()).data.user!.id, expected_income_id: B_INCOME, period: '2026-10', transaction_id: salaryTx });
  check('A/B: A cannot settle B\'s expected income', !!cross.error, JSON.stringify(cross.error));
});
