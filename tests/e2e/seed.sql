-- E2E seed for ALL suites (docs/runbooks/e2e.md). Idempotent: removes every previous probe user first.
-- Probe users live on the non-deliverable .invalid domain; one A/B pair per suite, so suites never share data:
--   s3*  auth-dashboard   s4*  review-manual   s56* import-learning   s78* analysis-dashboard   s9* planning-account
-- __E2E_PASSWORD__ is replaced at run time (scripts/e2e.sh render) — the password is never committed.
-- B rows attacked by id in the suites have fixed ids (see B_TX in tests/e2e/lib.ts).
-- Deleting a user cascades to all of its rows.
delete from auth.users where email like 'e2e-%@gestordefinanzas.invalid';

do $$
declare r record; u uuid; ta uuid;
  c_food uuid := (select id from public.categories where user_id is null and name = 'Alimentación');
  c_tr uuid := (select id from public.categories where user_id is null and name = 'Transporte');
  c_otros uuid := (select id from public.categories where user_id is null and name = 'Otros');
begin
  for r in select * from (values ('s3a'),('s3b'),('s4a'),('s4b'),('s56a'),('s56b'),('s78a'),('s78b'),('s9a'),('s9b')) v(tag) loop
    u := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current, phone_change, phone_change_token, reauthentication_token)
    values ('00000000-0000-0000-0000-000000000000', u, 'authenticated', 'authenticated', 'e2e-' || r.tag || '@gestordefinanzas.invalid',
      extensions.crypt('__E2E_PASSWORD__', extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '', '', '', '', '');
    insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (u::text, u, jsonb_build_object('sub', u::text, 'email', 'e2e-' || r.tag || '@gestordefinanzas.invalid', 'email_verified', true), 'email', now(), now(), now());

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
      values (case r.tag when 's4b' then '00000000-0000-4000-8000-00000000e4b1'::uuid else '00000000-0000-4000-8000-00000000e56b'::uuid end,
        u, '2026-09-14 12:00-05', 'expense', 'outflow', 5000, 'PEN', 'E2E SECRET B', 'review_required', 'medium', 'e2e-b-r');
    elsif r.tag = 's78a' then
      insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, merchant_raw, merchant_normalized, category_id, status, confidence, fingerprint) values
        (u, '2026-06-01 09:00-05', 'income', 'inflow', 500000, 'PEN', 'SUELDO', 'SUELDO', null, 'confirmed', 'high', 'e2e-1'),
        (u, '2026-06-15 12:00-05', 'expense', 'outflow', 400000, 'PEN', 'GASTOS JUNIO', 'GASTOS JUNIO', c_otros, 'confirmed', 'high', 'e2e-2'),
        (u, '2026-07-01 09:00-05', 'income', 'inflow', 500000, 'PEN', 'SUELDO', 'SUELDO', null, 'confirmed', 'high', 'e2e-3'),
        (u, '2026-07-15 12:00-05', 'expense', 'outflow', 400000, 'PEN', 'GASTOS JULIO', 'GASTOS JULIO', c_otros, 'confirmed', 'high', 'e2e-4'),
        (u, '2026-08-01 09:00-05', 'income', 'inflow', 500000, 'PEN', 'SUELDO', 'SUELDO', null, 'confirmed', 'high', 'e2e-5'),
        (u, '2026-08-10 12:00-05', 'expense', 'outflow', 50000, 'PEN', 'RESTAURANTE E2E', 'RESTAURANTE E2E', c_food, 'confirmed', 'high', 'e2e-6'),
        (u, '2026-08-11 12:00-05', 'expense', 'outflow', 20000, 'PEN', 'UBER E2E', 'UBER E2E', c_tr, 'confirmed', 'high', 'e2e-7'),
        (u, '2026-08-12 12:00-05', 'expense', 'outflow', 330000, 'PEN', 'ALQUILER E2E', 'ALQUILER E2E', c_otros, 'confirmed', 'high', 'e2e-8'),
        (u, '2026-09-01 09:00-05', 'income', 'inflow', 550000, 'PEN', 'SUELDO', 'SUELDO', null, 'confirmed', 'high', 'e2e-9'),
        (u, '2026-09-05 12:00-05', 'credit_card_purchase', 'outflow', 81000, 'PEN', 'RESTAURANTE E2E', 'RESTAURANTE E2E', c_food, 'confirmed', 'high', 'e2e-10'),
        (u, '2026-09-06 12:00-05', 'expense', 'outflow', 40000, 'PEN', 'UBER E2E', 'UBER E2E', c_tr, 'confirmed', 'high', 'e2e-11'),
        (u, '2026-09-07 12:00-05', 'credit_card_payment', 'outflow', 100000, 'PEN', 'PAGO VISA', 'PAGO VISA', null, 'confirmed', 'high', 'e2e-12'),
        (u, '2026-09-08 12:00-05', 'withdrawal', 'outflow', 20000, 'PEN', 'CAJERO', 'CAJERO', null, 'confirmed', 'high', 'e2e-13'),
        (u, '2026-09-09 12:00-05', 'expense', 'outflow', 1000, 'PEN', '=HYPERLINK("http://evil")', 'HYPERLINK HTTP EVIL', c_otros, 'confirmed', 'high', 'e2e-14'),
        (u, '2026-09-25 12:00-05', 'expense', 'outflow', 300000, 'PEN', 'TIENDA RARA E2E', 'TIENDA RARA E2E', c_otros, 'confirmed', 'high', 'e2e-15'),
        (u, '2026-09-20 12:00-05', 'expense', 'outflow', 5000, 'PEN', 'PENDIENTE E2E', 'PENDIENTE E2E', c_otros, 'review_required', 'medium', 'e2e-16'),
        (u, '2026-09-21 12:00-05', 'expense', 'outflow', 2000, 'USD', 'AMAZON E2E', 'AMAZON E2E', c_otros, 'confirmed', 'high', 'e2e-17');
      insert into public.transaction_sources (user_id, transaction_id, channel, external_event_id, parser_version, received_at)
        select user_id, id, 'manual', 'm-' || fingerprint, 'MANUAL', now() from public.transactions where user_id = u;
    elsif r.tag = 's78b' then
      insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, merchant_raw, merchant_normalized, category_id, status, confidence, fingerprint)
      values (u, '2026-09-10 12:00-05', 'expense', 'outflow', 7777, 'PEN', 'E2E SECRET B', 'E2E SECRET B', c_otros, 'confirmed', 'high', 'e2e-b');
    elsif r.tag = 's9a' then
      insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, merchant_raw, merchant_normalized, category_id, status, confidence, fingerprint)
      values (u, '2026-09-10 12:00-05', 'expense', 'outflow', 40000, 'PEN', 'MERCADO E2E', 'MERCADO E2E', c_food, 'confirmed', 'high', 'e2e-s9'),
        -- recurring (TASK-016): outside September so this month's figures stay S/ 400.00
        (u, '2026-06-05 12:00-05', 'expense', 'outflow', 4490, 'PEN', 'NETFLIX E2E', 'NETFLIX E2E', c_otros, 'confirmed', 'high', 'e2e-s9-n6'),
        (u, '2026-07-05 12:00-05', 'expense', 'outflow', 4490, 'PEN', 'NETFLIX E2E', 'NETFLIX E2E', c_otros, 'confirmed', 'high', 'e2e-s9-n7'),
        (u, '2026-08-06 12:00-05', 'expense', 'outflow', 4490, 'PEN', 'NETFLIX E2E', 'NETFLIX E2E', c_otros, 'confirmed', 'high', 'e2e-s9-n8');
    elsif r.tag = 's9b' then
      insert into public.budgets (user_id, category_id, amount_minor) values (u, c_food, 99900);
      insert into public.debts (user_id, name, principal_minor, balance_minor) values (u, 'B deuda secreta', 100000, 50000);
      insert into public.subscriptions (user_id, plan, status) values (u, 'plus', 'active');
    end if;
  end loop;
end $$;
