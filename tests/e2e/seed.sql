-- E2E seed for ALL suites (docs/runbooks/e2e.md). Insert-only and idempotent: every render gets a fresh run id
-- (__E2E_RUN__), so probe users are new and deterministic per run (e2e-<tag>-<run>@gestordefinanzas.invalid) and the
-- seed never depends on a previous cleanup. It never deletes or updates anything: cleanup is tests/e2e/cleanup.sql.
-- Probe users live on the non-deliverable .invalid domain; one A/B pair per suite, so suites never share data:
--   s3*  auth-dashboard   s4*  review-manual   s56* import-learning   s78* analysis-dashboard   s9* planning-account   s10* splits   s11* cashflow   s12* onboarding   s13* income-link   s14* vels
-- __E2E_PASSWORD__ is replaced at run time (scripts/e2e.sh render) — the password is never committed.
-- B rows attacked by id in the suites have fixed ids (see B_TX in tests/e2e/lib.ts).
-- Fixed ids are derived from the run (md5('<run>:<name>')), so two runs never collide.

do $$
declare r record; u uuid; ta uuid; em text;
  -- Dated fixtures are relative to the Lima calendar (month m0 = this month, clamped to today), never pinned to a date.
  lt constant date := (now() at time zone 'America/Lima')::date;
  m0 constant date := date_trunc('month', lt)::date;
  dd constant int := extract(day from lt)::int;
  run constant text := '__E2E_RUN__';
  c_food uuid := (select id from public.categories where user_id is null and name = 'Alimentación');
  c_tr uuid := (select id from public.categories where user_id is null and name = 'Transporte');
  c_otros uuid := (select id from public.categories where user_id is null and name = 'Otros');
begin
  -- Namespace guard: refuse anything but the synthetic run format (never a real user).
  if run !~ '^[a-z0-9]{8,20}$' then raise exception 'e2e seed: invalid run id %', run; end if;
  for r in select * from (values ('s3a'),('s3b'),('s4a'),('s4b'),('s56a'),('s56b'),('s78a'),('s78b'),('s9a'),('s9b'),('s10a'),('s10b'),('s11a'),('s11b'),('s12a'),('s12b'),('s13a'),('s13b'),('s14a'),('s14b')) v(tag) loop
    u := gen_random_uuid();
    em := 'e2e-' || r.tag || '-' || run || '@gestordefinanzas.invalid';
    if em !~ '^e2e-s[0-9]+[ab]-[a-z0-9]{8,20}@gestordefinanzas\.invalid$' then raise exception 'e2e seed: % is outside the synthetic namespace', em; end if;
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current, phone_change, phone_change_token, reauthentication_token)
    values ('00000000-0000-0000-0000-000000000000', u, 'authenticated', 'authenticated', em,
      extensions.crypt('__E2E_PASSWORD__', extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '', '', '', '', '');
    insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (u::text, u, jsonb_build_object('sub', u::text, 'email', em, 'email_verified', true), 'email', now(), now(), now());

    if r.tag = 's3a' then
      insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, merchant_raw, merchant_normalized, status, confidence, fingerprint) values
        (u, '2026-09-10 15:00-05', 'credit_card_purchase', 'outflow', 10000, 'PEN', 'E2E RESTAURANTE A', 'E2E RESTAURANTE A', 'confirmed', 'high', 'e2e-a-1'),
        (u, '2026-09-12 15:00-05', 'credit_card_payment', 'outflow', 10000, 'PEN', 'PAGO TARJETA', 'PAGO TARJETA', 'confirmed', 'high', 'e2e-a-2'),
        (u, '2026-09-14 15:00-05', 'withdrawal', 'outflow', 20000, 'PEN', 'RETIRO CAJERO', 'RETIRO CAJERO', 'confirmed', 'high', 'e2e-a-3');
    elsif r.tag = 's3b' then
      insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, merchant_raw, merchant_normalized, status, confidence, fingerprint) values
        (u, '2026-09-11 15:00-05', 'credit_card_purchase', 'outflow', 5000, 'PEN', 'E2E SECRET B', 'E2E SECRET B', 'confirmed', 'high', 'e2e-b-1');
    elsif r.tag = 's4a' then
      insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, institution_code, card_last4, merchant_raw, merchant_normalized, category_id, status, confidence, fingerprint)
      values (u, '2026-09-15 20:30-05', 'expense', 'outflow', 10000, 'PEN', 'BCP', '4821', 'E2E REVIEW A', 'E2E REVIEW A', c_otros, 'review_required', 'medium', 'e2e-a-r') returning id into ta;
      insert into public.transaction_sources (user_id, transaction_id, channel, external_event_id, parser_version, template_verification, received_at)
      values (u, ta, 'sms', 'e2e-sms-a', 'BCP_SMS_V1', 'SYNTHETIC_UNVERIFIED', '2026-09-15 20:31-05');
      insert into public.financial_events (user_id, channel, external_event_id, parser_version, outcome, detail, transaction_id)
      values (u, 'sms', 'e2e-sms-a', 'BCP_SMS_V1', 'created', 'card_not_registered', ta);
      insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, institution_code, merchant_raw, merchant_normalized, category_id, status, confidence, fingerprint, duplicate_of_id)
      values (u, '2026-09-16 10:00-05', 'expense', 'outflow', 4000, 'PEN', 'BCP', 'E2E DUP A', 'E2E DUP A', c_food, 'possible_duplicate', 'high', 'e2e-a-d', ta);
      insert into public.accounts (user_id, institution_code, alias, currency, last4) values (u, 'BCP', 'E2E Ahorros', 'PEN', '9001');
    elsif r.tag in ('s4b', 's56b') then
      insert into public.transactions (id, user_id, occurred_at, type, direction, amount_minor, currency, merchant_raw, status, confidence, fingerprint)
      values (case r.tag when 's4b' then md5(run || ':e4b1')::uuid else md5(run || ':e56b')::uuid end,
        u, '2026-09-14 12:00-05', 'expense', 'outflow', 5000, 'PEN', 'E2E SECRET B', 'review_required', 'medium', 'e2e-b-r');
    elsif r.tag = 's78a' then
      insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, merchant_raw, merchant_normalized, category_id, status, confidence, fingerprint) values
        (u, (((m0 - interval '3 months')::date + 0) + time '09:00') at time zone 'America/Lima', 'income', 'inflow', 500000, 'PEN', 'SUELDO', 'SUELDO', null, 'confirmed', 'high', 'e2e-1'),
        (u, (((m0 - interval '3 months')::date + 14) + time '12:00') at time zone 'America/Lima', 'expense', 'outflow', 400000, 'PEN', 'GASTOS JUNIO', 'GASTOS JUNIO', c_otros, 'confirmed', 'high', 'e2e-2'),
        (u, (((m0 - interval '2 months')::date + 0) + time '09:00') at time zone 'America/Lima', 'income', 'inflow', 500000, 'PEN', 'SUELDO', 'SUELDO', null, 'confirmed', 'high', 'e2e-3'),
        (u, (((m0 - interval '2 months')::date + 14) + time '12:00') at time zone 'America/Lima', 'expense', 'outflow', 400000, 'PEN', 'GASTOS JULIO', 'GASTOS JULIO', c_otros, 'confirmed', 'high', 'e2e-4'),
        (u, (((m0 - interval '1 months')::date + 0) + time '09:00') at time zone 'America/Lima', 'income', 'inflow', 500000, 'PEN', 'SUELDO', 'SUELDO', null, 'confirmed', 'high', 'e2e-5'),
        (u, (((m0 - interval '1 months')::date + 9) + time '12:00') at time zone 'America/Lima', 'expense', 'outflow', 50000, 'PEN', 'RESTAURANTE E2E', 'RESTAURANTE E2E', c_food, 'confirmed', 'high', 'e2e-6'),
        (u, (((m0 - interval '1 months')::date + 10) + time '12:00') at time zone 'America/Lima', 'expense', 'outflow', 20000, 'PEN', 'UBER E2E', 'UBER E2E', c_tr, 'confirmed', 'high', 'e2e-7'),
        (u, (((m0 - interval '1 months')::date + 11) + time '12:00') at time zone 'America/Lima', 'expense', 'outflow', 330000, 'PEN', 'ALQUILER E2E', 'ALQUILER E2E', c_otros, 'confirmed', 'high', 'e2e-8'),
        (u, least(((m0 + least(1, dd) - 1) + time '09:00') at time zone 'America/Lima', now() - interval '1 minute'), 'income', 'inflow', 550000, 'PEN', 'SUELDO', 'SUELDO', null, 'confirmed', 'high', 'e2e-9'),
        (u, least(((m0 + least(5, dd) - 1) + time '12:00') at time zone 'America/Lima', now() - interval '1 minute'), 'credit_card_purchase', 'outflow', 81000, 'PEN', 'RESTAURANTE E2E', 'RESTAURANTE E2E', c_food, 'confirmed', 'high', 'e2e-10'),
        (u, least(((m0 + least(6, dd) - 1) + time '12:00') at time zone 'America/Lima', now() - interval '1 minute'), 'expense', 'outflow', 40000, 'PEN', 'UBER E2E', 'UBER E2E', c_tr, 'confirmed', 'high', 'e2e-11'),
        (u, least(((m0 + least(7, dd) - 1) + time '12:00') at time zone 'America/Lima', now() - interval '1 minute'), 'credit_card_payment', 'outflow', 100000, 'PEN', 'PAGO VISA', 'PAGO VISA', null, 'confirmed', 'high', 'e2e-12'),
        (u, least(((m0 + least(8, dd) - 1) + time '12:00') at time zone 'America/Lima', now() - interval '1 minute'), 'withdrawal', 'outflow', 20000, 'PEN', 'CAJERO', 'CAJERO', null, 'confirmed', 'high', 'e2e-13'),
        (u, least(((m0 + least(9, dd) - 1) + time '12:00') at time zone 'America/Lima', now() - interval '1 minute'), 'expense', 'outflow', 1000, 'PEN', '=HYPERLINK("http://evil")', 'HYPERLINK HTTP EVIL', c_otros, 'confirmed', 'high', 'e2e-14'),
        (u, least(((m0 + least(25, dd) - 1) + time '12:00') at time zone 'America/Lima', now() - interval '1 minute'), 'expense', 'outflow', 300000, 'PEN', 'TIENDA RARA E2E', 'TIENDA RARA E2E', c_otros, 'confirmed', 'high', 'e2e-15'),
        (u, least(((m0 + least(20, dd) - 1) + time '12:00') at time zone 'America/Lima', now() - interval '1 minute'), 'expense', 'outflow', 5000, 'PEN', 'PENDIENTE E2E', 'PENDIENTE E2E', c_otros, 'review_required', 'medium', 'e2e-16'),
        (u, least(((m0 + least(21, dd) - 1) + time '12:00') at time zone 'America/Lima', now() - interval '1 minute'), 'expense', 'outflow', 2000, 'USD', 'AMAZON E2E', 'AMAZON E2E', c_otros, 'confirmed', 'high', 'e2e-17');
      insert into public.transaction_sources (user_id, transaction_id, channel, external_event_id, parser_version, received_at)
        select user_id, id, 'manual', 'm-' || fingerprint, 'MANUAL', now() from public.transactions where user_id = u;
    elsif r.tag = 's78b' then
      insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, merchant_raw, merchant_normalized, category_id, status, confidence, fingerprint)
      values (u, '2026-09-10 12:00-05', 'expense', 'outflow', 7777, 'PEN', 'E2E SECRET B', 'E2E SECRET B', c_otros, 'confirmed', 'high', 'e2e-b');
    elsif r.tag = 's9a' then
      insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, merchant_raw, merchant_normalized, category_id, status, confidence, fingerprint)
      values (u, least(((m0 + least(10, dd) - 1) + time '12:00') at time zone 'America/Lima', now() - interval '1 minute'), 'expense', 'outflow', 40000, 'PEN', 'MERCADO E2E', 'MERCADO E2E', c_food, 'confirmed', 'high', 'e2e-s9'),
        -- recurring (TASK-016): outside September so this month's figures stay S/ 400.00
        (u, (((m0 - interval '3 months')::date + 4) + time '12:00') at time zone 'America/Lima', 'expense', 'outflow', 4490, 'PEN', 'NETFLIX E2E', 'NETFLIX E2E', c_otros, 'confirmed', 'high', 'e2e-s9-n6'),
        (u, (((m0 - interval '2 months')::date + 4) + time '12:00') at time zone 'America/Lima', 'expense', 'outflow', 4490, 'PEN', 'NETFLIX E2E', 'NETFLIX E2E', c_otros, 'confirmed', 'high', 'e2e-s9-n7'),
        (u, (((m0 - interval '1 months')::date + 5) + time '12:00') at time zone 'America/Lima', 'expense', 'outflow', 4490, 'PEN', 'NETFLIX E2E', 'NETFLIX E2E', c_otros, 'confirmed', 'high', 'e2e-s9-n8');
    elsif r.tag = 's10a' then
      -- splits (TASK-020): S/ 180.00 confirmed restaurant this month + S/ 50 pending (not splittable)
      insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, merchant_raw, merchant_normalized, category_id, status, confidence, fingerprint) values
        (u, '2026-09-12 21:00-05', 'credit_card_purchase', 'outflow', 18000, 'PEN', 'RESTAURANTE SPLIT E2E', 'RESTAURANTE SPLIT E2E', c_food, 'confirmed', 'high', 'e2e-s10-1'),
        (u, '2026-09-13 10:00-05', 'expense', 'outflow', 5000, 'PEN', 'PENDIENTE SPLIT E2E', 'PENDIENTE SPLIT E2E', c_otros, 'review_required', 'medium', 'e2e-s10-2');
    elsif r.tag = 's10b' then
      insert into public.transactions (id, user_id, occurred_at, type, direction, amount_minor, currency, merchant_raw, merchant_normalized, category_id, status, confidence, fingerprint)
      values (md5(run || ':e10b')::uuid, u, '2026-09-12 12:00-05', 'expense', 'outflow', 9900, 'PEN', 'E2E SECRET B', 'E2E SECRET B', c_food, 'confirmed', 'high', 'e2e-s10-b');
    elsif r.tag = 's11a' then
      -- Cash-flow planning demo (ADR-0005), all synthetic: balance S/ 5,000; salary on the 15th; car 9-10 (pay on the 7th);
      -- card on the 10th; internet amount unknown; phone on the 5th; rent on the 20th; yearly insurance (reserve);
      -- electricity expected 129.00 but last paid 160.00 (variation); an unlinked car payment last month (suggestion);
      -- a salary that just came in (income event); two debts, one without a rate.
      insert into public.balance_snapshots (user_id, currency, amount_minor) values (u, 'PEN', 500000);
      insert into public.expected_incomes (user_id, name, currency, amount_minor, amount_status, frequency, day_of_month) values (u, 'Sueldo', 'PEN', 400000, 'estimated', 'monthly', 15);
      insert into public.planning_settings (user_id, currency, essentials_monthly_minor, cushion_minor) values (u, 'PEN', 80000, 40000);
      insert into public.fixed_expenses (user_id, name, kind, currency, amount_minor, amount_status, due_day, due_day_max, target_day) values
        (u, 'Carro', 'car', 'PEN', 95000, 'confirmed', 9, 10, 7),
        (u, 'Tarjeta', 'card', 'PEN', 50000, 'confirmed', 10, null, null),
        (u, 'Internet', 'internet', 'PEN', null, 'unknown', 13, null, null),
        (u, 'Celular', 'phone', 'PEN', 10000, 'confirmed', 5, null, null),
        (u, 'Alquiler', 'rent', 'PEN', 150000, 'confirmed', 20, null, null),
        (u, 'Luz', 'services', 'PEN', 12900, 'estimated', 18, null, null);
      insert into public.fixed_expenses (user_id, name, kind, currency, amount_minor, frequency, anchor_month, due_day) values (u, 'Seguro', 'insurance', 'PEN', 120000, 'yearly', 3, 1);
      insert into public.debts (user_id, name, principal_minor, balance_minor, annual_rate_bp, installment_minor, due_day) values
        (u, 'Visa', 500000, 300000, 6000, null, null), (u, 'Préstamo familiar', 100000, 100000, null, null, null);
      insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, merchant_raw, merchant_normalized, status, confidence, fingerprint) values
        (u, now() - interval '2 days', 'income', 'inflow', 400000, 'PEN', 'SUELDO DEMO', 'SUELDO DEMO', 'confirmed', 'high', 'e2e-s11-in'),
        (u, date_trunc('month', now()) - interval '22 days', 'expense', 'outflow', 95000, 'PEN', 'PAGO CUOTA CARRO', 'PAGO CUOTA CARRO', 'confirmed', 'high', 'e2e-s11-car');
      insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, merchant_raw, merchant_normalized, status, confidence, fingerprint)
        values (u, date_trunc('month', now()) - interval '12 days', 'expense', 'outflow', 16000, 'PEN', 'LUZ DEL SUR', 'LUZ DEL SUR', 'confirmed', 'high', 'e2e-s11-luz') returning id into ta;
      insert into public.plan_settlements (user_id, fixed_expense_id, period, transaction_id)
        select u, id, to_char(date_trunc('month', now()) - interval '12 days', 'YYYY-MM'), ta from public.fixed_expenses where user_id = u and name = 'Luz';
    elsif r.tag = 's11b' then
      insert into public.fixed_expenses (id, user_id, name, currency, amount_minor, due_day) values (md5(run || ':e11b')::uuid, u, 'B secreto', 'PEN', 99900, 10);
      insert into public.balance_snapshots (user_id, currency, amount_minor) values (u, 'PEN', 777700);
    elsif r.tag = 's12b' then
      -- B for the onboarding suite: its own conversation, usage and planning rows A must never see or consume.
      insert into public.conversation_messages (user_id, thread, role, body) values (u, 'assistant', 'user', 'B secreto conversación');
      insert into public.ai_usage (user_id, bucket, weighted_tokens, camera_reads) values (u, 'onboarding', 777, 1);
      insert into public.expected_incomes (user_id, name, currency, amount_minor, amount_status, day_of_month) values (u, 'B sueldo secreto', 'PEN', 999900, 'confirmed', 7);
    elsif r.tag = 's13a' then
      -- Received ↔ expected income (ADR-0007), date-independent (Lima calendar): salary expected in 3 days paid
      -- early yesterday (links → horizon moves); two equal bonuses expected yesterday + one deposit (must choose);
      -- a USD income and a PEN deposit of the same number (must never cross).
      insert into public.balance_snapshots (user_id, currency, amount_minor) values (u, 'PEN', 300000);
      insert into public.planning_settings (user_id, currency, essentials_monthly_minor, cushion_minor) values (u, 'PEN', 60000, 0);
      insert into public.expected_incomes (user_id, name, currency, amount_minor, amount_status, frequency, day_of_month) values
        (u, 'Sueldo', 'PEN', 400000, 'confirmed', 'monthly', extract(day from (now() at time zone 'America/Lima')::date + 3)::int),
        (u, 'Bono A', 'PEN', 150000, 'confirmed', 'monthly', extract(day from (now() at time zone 'America/Lima')::date - 1)::int),
        (u, 'Bono B', 'PEN', 150000, 'confirmed', 'monthly', extract(day from (now() at time zone 'America/Lima')::date - 1)::int),
        (u, 'Freelance', 'USD', 100000, 'confirmed', 'monthly', extract(day from (now() at time zone 'America/Lima')::date - 1)::int);
      insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, merchant_raw, merchant_normalized, status, confidence, fingerprint) values
        (u, now() - interval '1 day', 'income', 'inflow', 400000, 'PEN', 'SUELDO E2E', 'SUELDO E2E', 'confirmed', 'high', 'e2e-s13-sal'),
        (u, now() - interval '1 day' + interval '1 minute', 'income', 'inflow', 150000, 'PEN', 'BONO E2E', 'BONO E2E', 'confirmed', 'high', 'e2e-s13-bono'),
        (u, now() - interval '1 day' + interval '2 minutes', 'income', 'inflow', 100000, 'PEN', 'PEN MISMO NUMERO', 'PEN MISMO NUMERO', 'confirmed', 'high', 'e2e-s13-pen');
    elsif r.tag = 's13b' then
      insert into public.expected_incomes (id, user_id, name, currency, amount_minor, amount_status, day_of_month)
        values (md5(run || ':e13b')::uuid, u, 'B sueldo secreto', 'PEN', 400000, 'confirmed', 5);
    elsif r.tag = 's14a' then
      -- Vels (ADR-0011): same core as the dashboard. Card with a bank limit, its debt and planned payment.
      insert into public.balance_snapshots (user_id, currency, amount_minor) values (u, 'PEN', 500000);
      insert into public.expected_incomes (user_id, name, currency, amount_minor, amount_status, frequency, day_of_month) values (u, 'Sueldo', 'PEN', 400000, 'estimated', 'monthly', 15);
      insert into public.planning_settings (user_id, currency, essentials_monthly_minor, cushion_minor) values (u, 'PEN', 80000, 0);
      insert into public.fixed_expenses (user_id, name, kind, currency, amount_minor, amount_status, due_day) values (u, 'Tarjeta BCP', 'card', 'PEN', 50000, 'estimated', 10);
      insert into public.debts (user_id, name, principal_minor, balance_minor, annual_rate_bp) values (u, 'Tarjeta BCP', 300000, 300000, 6000);
      insert into public.cards (user_id, institution_code, alias, kind, currency, last4, credit_limit_minor) values (u, 'BCP', 'Tarjeta BCP', 'credit', 'PEN', '1111', 1000000);
    elsif r.tag = 's14b' then
      insert into public.debts (user_id, name, principal_minor, balance_minor) values (u, 'B deuda secreta', 100000, 90000);
    elsif r.tag = 's9b' then
      insert into public.budgets (user_id, category_id, amount_minor) values (u, c_food, 99900);
      insert into public.debts (user_id, name, principal_minor, balance_minor) values (u, 'B deuda secreta', 100000, 50000);
      insert into public.subscriptions (user_id, plan, status) values (u, 'plus', 'active');
    end if;
    -- Every probe user has finished onboarding except s12a, the first-time user of the onboarding suite (ADR-0006).
    if r.tag <> 's12a' then insert into public.onboarding_states (user_id, status, completed_at) values (u, 'completed', now()); end if;
    if r.tag = 's12a' then insert into public.demo_access (user_id) values (u); end if;
  end loop;
end $$;
