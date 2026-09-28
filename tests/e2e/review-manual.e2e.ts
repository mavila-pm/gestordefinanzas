/**
 * TASK-004 end-to-end check against the REAL Supabase project, driven through the running app.
 * A and B (password E2E_PASSWORD); seeded data (A: "E2E REVIEW A" S/100 review_required with card ****4821 not
 * registered and an SMS source; "E2E DUP A" S/40 possible_duplicate; account "E2E Ahorros". B: "E2E SECRET B",
 * Run all suites: scripts/e2e.sh (seed: tests/e2e/seed.sql).
 */
import { ALERT, BASE, B_TX, act, apiAs, login, nav, probe, runSuite, sameJson } from './lib.ts';

const A = probe('s4a');

await runSuite('review-manual', async ({ page, check }) => {
  await login(page, A);

  // 1. Review queue: own item with a plain-language reason; never B's
  await page.goto(`${BASE}/app/revisar`);
  const queue = (await page.getByTestId('review-list').textContent()) ?? '';
  check('queue lists A item', queue.includes('E2E REVIEW A'), queue);
  check('queue explains the unidentified card', queue.includes('****4821 no identificada'), queue);
  check('queue does NOT list B item', !queue.includes('E2E SECRET B'), queue);
  check('queue shows no internal terms', !/BCP_EMAIL|BCP_SMS|fingerprint|parser/i.test(queue), queue);
  check('nav badge counts pending items', (await page.getByTestId('review-count').textContent()) === '2');
  check('queue explains the possible duplicate', queue.includes('Posible duplicado'), queue);

  // 1b. Ignore the duplicate from the queue
  const dupItem = page.getByTestId('review-item').filter({ hasText: 'E2E DUP A' });
  await act(page, () => dupItem.getByRole('button', { name: 'Es duplicado, ignorar' }).click());
  await page.reload();
  const queueAfterIgnore = (await page.getByTestId('review-list').textContent()) ?? '';
  check('ignored duplicate leaves the queue', !queueAfterIgnore.includes('E2E DUP A'), queueAfterIgnore);

  // 2. Detail: register the card, then correct + confirm
  await nav(page, () => page.getByTestId('review-item').filter({ hasText: 'E2E REVIEW A' }).getByText('Corregir / ver origen').click());
  const detailUrl = page.url();
  await page.fill('form[aria-label="Registrar tarjeta"] input[name=alias]', 'E2E Visa');
  await page.selectOption('form[aria-label="Registrar tarjeta"] select[name=kind]', 'credit');
  await act(page, () => page.click('form[aria-label="Registrar tarjeta"] button[type=submit]'));
  check('card registration returns to the movement', page.url() === detailUrl, page.url());
  const correction = 'form[aria-label="Corregir movimiento"]';
  const cardValue = await page.locator(`${correction} select[name=cardId] option`, { hasText: 'E2E Visa' }).getAttribute('value');
  await page.selectOption(`${correction} select[name=cardId]`, cardValue ?? '');
  await page.selectOption(`${correction} select[name=categoryId]`, { label: 'Alimentación' });
  await page.selectOption(`${correction} select[name=accountId]`, { label: 'E2E Ahorros ****9001' });
  await page.fill(`${correction} input[name=amount]`, '95.50');
  await act(page, () => page.click(`${correction} button[value="1"]`));
  const status = await page.locator(`${correction} [role=status], ${correction} ${ALERT}`).first().textContent();
  check('correction saved and confirmed', !!status?.includes('confirmado'), status ?? '');
  await page.reload();
  const history = (await page.getByTestId('audit-list').textContent()) ?? '';
  check('history keeps original amount (S/ 100.00 → S/ 95.50)', history.includes('S/ 100.00 → S/ 95.50'), history);
  check('origin still shows the bank notification', (await page.content()).includes('Notificación por'));

  // 3. Queue empty
  await page.goto(`${BASE}/app/revisar`);
  check('queue empty after review', (await page.content()).includes('Todo al día'));

  // 4. Manual entry: ATM withdrawal is not an expense
  await page.goto(`${BASE}/app/movimientos/nuevo`);
  await page.selectOption('select[name=type]', 'withdrawal');
  await page.fill('input[name=amount]', '200');
  await page.fill('input[name=description]', 'E2E CAJERO');
  await Promise.all([page.waitForURL(/ok=1/), page.click('form[aria-label="Registrar movimiento"] button[type=submit]')]);
  check('manual entry saved', (await page.locator('[role=status]').first().textContent())?.includes('registrado') ?? false);
  await page.goto(`${BASE}/app?month=2026-09`);
  check('expenses = S/ 95.50 (withdrawal excluded)', (await page.getByTestId('expenses-PEN').textContent()) === 'S/ 95.50',
    (await page.getByTestId('expenses-PEN').textContent()) ?? '');
  check('withdrawal shown apart', (await page.content()).includes('Retiros de efectivo'));

  // 5. B's movement through the UI: 404
  const res = await page.goto(`${BASE}/app/movimientos/${B_TX.review}`);
  check('A opening B movement -> 404', res?.status() === 404, String(res?.status()));

  // 6. Bypass attempts with A's own session straight against the API (what a malicious browser could do)
  const sb = await apiAs(A);
  const own = await sb.from('transactions').select('id').limit(1).single();
  const upd = await sb.from('transactions').update({ status: 'confirmed', amount_minor: 1 }).eq('id', own.data?.id ?? '');
  check('direct UPDATE of own transaction denied (42501)', upd.error?.code === '42501', JSON.stringify(upd.error));
  const ins = await sb.from('transactions').insert({ occurred_at: new Date().toISOString(), type: 'income', direction: 'inflow',
    amount_minor: 100, currency: 'PEN', status: 'confirmed', confidence: 'high', fingerprint: 'x' });
  check('direct INSERT denied (42501)', ins.error?.code === '42501', JSON.stringify(ins.error));
  const del = await sb.from('transactions').delete().eq('id', own.data?.id ?? '');
  check('direct DELETE denied (42501)', del.error?.code === '42501', JSON.stringify(del.error));
  const rb = await sb.rpc('review_transaction', { p_id: B_TX.review, p_action: 'confirm' });
  const ib = await sb.rpc('review_transaction', { p_id: B_TX.review, p_action: 'ignore' });
  check('ignore of B transaction -> not_found', ib.error?.message === 'not_found', JSON.stringify(ib.error));
  check('RPC on B transaction -> not_found', rb.error?.message === 'not_found', JSON.stringify(rb.error));
  const cb = await sb.rpc('correct_transaction', { p_id: B_TX.review, p_changes: { amount_minor: 1 }, p_confirm: true });
  check('correction of B transaction -> not_found', cb.error?.message === 'not_found', JSON.stringify(cb.error));
  const audit = await sb.from('audit_events').insert({ user_id: (await sb.auth.getUser()).data.user?.id, action: 'confirm' });
  check('direct audit insert denied', !!audit.error, JSON.stringify(audit.error));
  const helper = await sb.rpc('direction_for', { t: 'expense' });
  check('internal helper not exposed', !!helper.error, JSON.stringify(helper.error));

  // 7. Provenance is immutable for the client and through the write functions
  const reviewTx = (await sb.from('transactions').select('id').eq('merchant_raw', 'E2E REVIEW A').single()).data?.id ?? '';
  const srcUpd = await sb.from('transaction_sources').update({ parser_version: 'FORGED' }).eq('transaction_id', reviewTx);
  check('transaction_sources UPDATE denied', srcUpd.error?.code === '42501', JSON.stringify(srcUpd.error));
  const srcDel = await sb.from('transaction_sources').delete().eq('transaction_id', reviewTx);
  check('transaction_sources DELETE denied', srcDel.error?.code === '42501', JSON.stringify(srcDel.error));
  const srcIns = await sb.from('transaction_sources').insert({ user_id: (await sb.auth.getUser()).data.user?.id, transaction_id: reviewTx,
    channel: 'email', external_event_id: 'forged', parser_version: 'BCP_EMAIL_V1', received_at: new Date().toISOString() });
  check('transaction_sources INSERT denied', srcIns.error?.code === '42501', JSON.stringify(srcIns.error));
  const evUpd = await sb.from('financial_events').update({ detail: 'forged' }).eq('transaction_id', reviewTx);
  check('financial_events UPDATE denied', evUpd.error?.code === '42501', JSON.stringify(evUpd.error));
  for (const key of ['parser_version', 'fingerprint', 'status', 'direction', 'user_id', 'card_last4']) {
    const r = await sb.rpc('correct_transaction', { p_id: reviewTx, p_changes: { [key]: 'x' }, p_confirm: false });
    check(`correct_transaction rejects "${key}"`, r.error?.message === 'invalid_field', JSON.stringify(r.error));
  }
  const sources = (await sb.from('transaction_sources').select('channel,external_event_id,parser_version,template_verification').eq('transaction_id', reviewTx)).data;
  check('original SMS source intact after correction', sameJson(sources, [
    { channel: 'sms', external_event_id: 'e2e-sms-a', parser_version: 'BCP_SMS_V1', template_verification: 'SYNTHETIC_UNVERIFIED' }]), JSON.stringify(sources));
  const ev = (await sb.from('financial_events').select('outcome,detail,parser_version').eq('transaction_id', reviewTx)).data;
  check('original ingestion event intact', sameJson(ev, [{ outcome: 'created', detail: 'card_not_registered', parser_version: 'BCP_SMS_V1' }]), JSON.stringify(ev));

  // 8. Audit trail preserves before/after
  const cats = (await sb.from('categories').select('id,name').in('name', ['Otros', 'Alimentación']).is('user_id', null)).data ?? [];
  const catId = (n: string) => cats.find((c) => c.name === n)?.id;
  const card = (await sb.from('cards').select('id').eq('last4', '4821').single()).data?.id;
  const account = (await sb.from('accounts').select('id').eq('alias', 'E2E Ahorros').single()).data?.id;
  const corr = (await sb.from('audit_events').select('action,changes').eq('transaction_id', reviewTx)).data ?? [];
  const ch = corr.find((a) => a.action === 'correct')?.changes as Record<string, { from: unknown; to: unknown }> | undefined;
  const link = corr.find((a) => a.action === 'card_link')?.changes as Record<string, { from: unknown; to: unknown }> | undefined;
  check('audit: one card link (on card registration, TASK-014) + exactly one correction event', corr.length === 2 && !!ch && !!link, JSON.stringify(corr));
  check('audit: amount 10000 -> 9550', sameJson(ch?.amount_minor, { from: 10000, to: 9550 }), JSON.stringify(ch?.amount_minor));
  check('audit: category Otros -> Alimentación', ch?.category_id?.from === catId('Otros') && ch?.category_id?.to === catId('Alimentación'), JSON.stringify(ch?.category_id));
  check('audit: card null -> registered card (linked when the card was registered)', link?.card_id?.from === null && link?.card_id?.to === card, JSON.stringify(link));
  check('audit: account null -> E2E Ahorros', ch?.account_id?.from === null && ch?.account_id?.to === account, JSON.stringify(ch?.account_id));
  check('audit: status review_required -> confirmed', sameJson(ch?.status, { from: 'review_required', to: 'confirmed' }), JSON.stringify(ch?.status));
  check('audit: no untouched fields recorded', Object.keys(ch ?? {}).sort().join(',') === 'account_id,amount_minor,category_id,status', Object.keys(ch ?? {}).join(','));
  const dupId = (await sb.from('transactions').select('id,status').eq('merchant_raw', 'E2E DUP A').single()).data;
  check('ignored duplicate kept (not deleted), status ignored', dupId?.status === 'ignored', JSON.stringify(dupId));
  const ign = (await sb.from('audit_events').select('action,changes').eq('transaction_id', dupId?.id ?? '')).data;
  check('audit: ignore possible_duplicate -> ignored', sameJson(ign, [{ action: 'ignore', changes: { status: { from: 'possible_duplicate', to: 'ignored' } } }]), JSON.stringify(ign));
  const final = (await sb.from('transactions').select('type,direction,amount_minor,status,card_id,account_id').eq('id', reviewTx).single()).data;
  check('final row: expense/outflow S/95.50 confirmed with card and account', final?.type === 'expense' && final?.direction === 'outflow'
    && Number(final?.amount_minor) === 9550 && final?.status === 'confirmed' && final?.card_id === card && final?.account_id === account, JSON.stringify(final));
  await sb.auth.signOut();
});
