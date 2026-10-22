-- Demo account with ~6 months of SYNTHETIC history, to try every screen by hand (Supabase DEV only).
-- Insert-only: creates ONE new user demo-<run>@gestordefinanzas.invalid (non-deliverable domain) and its rows; it never
-- updates or deletes anything and never touches a real account. Render with scripts/qa/demo-account.sh (fresh run id +
-- password from the environment; the password is never committed). Dates are relative to today in Lima.
-- Remove later: delete from auth.users where email = 'demo-<run>@gestordefinanzas.invalid' (rows cascade).
do $$
declare
  u uuid := gen_random_uuid();
  run constant text := '__DEMO_RUN__';
  em text := 'demo-' || '__DEMO_RUN__' || '@gestordefinanzas.invalid';
  lt constant date := (now() at time zone 'America/Lima')::date;
  m0 constant date := date_trunc('month', lt)::date;
  c_food uuid := (select id from public.categories where user_id is null and name = 'Alimentación');
  c_tr uuid := (select id from public.categories where user_id is null and name = 'Transporte');
  c_home uuid := (select id from public.categories where user_id is null and name = 'Vivienda');
  c_serv uuid := (select id from public.categories where user_id is null and name = 'Servicios');
  c_fun uuid := (select id from public.categories where user_id is null and name = 'Ocio');
  c_health uuid := (select id from public.categories where user_id is null and name = 'Salud');
  c_pers uuid := (select id from public.categories where user_id is null and name = 'Personal');
  c_other uuid := (select id from public.categories where user_id is null and name = 'Otros');
  card uuid; ta uuid; m int; dy int; d date; k int; amt bigint; n int := 0; cut date;
begin
  if run !~ '^[a-z0-9]{8,20}$' then raise exception 'demo seed: invalid run id %', run; end if;
  if em !~ '^demo-[a-z0-9]{8,20}@gestordefinanzas\.invalid$' then raise exception 'demo seed: % is outside the demo namespace', em; end if;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current, phone_change, phone_change_token, reauthentication_token)
  values ('00000000-0000-0000-0000-000000000000', u, 'authenticated', 'authenticated', em,
    extensions.crypt('__DEMO_PASSWORD__', extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}', '{}', now() - interval '6 months', now(), '', '', '', '', '', '', '', '');
  insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (u::text, u, jsonb_build_object('sub', u::text, 'email', em, 'email_verified', true), 'email', now(), now(), now());

  -- Registration and onboarding done; Plus active so the whole history is visible (Free shows 3 months).
  insert into public.profiles (user_id, display_name, password_set_at, registration_completed_at) values (u, 'Demo', now(), now())
    on conflict (user_id) do update set display_name = 'Demo';
  insert into public.onboarding_states (user_id, status, completed_at) values (u, 'completed', now());
  insert into public.subscriptions (user_id, plan, status) values (u, 'plus', 'active');

  -- Accounts and cards.
  insert into public.accounts (user_id, institution_code, alias, currency, last4) values
    (u, 'BCP', 'Ahorros BCP', 'PEN', '9001'), (u, 'BBVA', 'Sueldo BBVA', 'PEN', '3300'), (u, 'INTERBANK', 'Dólares Interbank', 'USD', '7700');
  insert into public.cards (user_id, institution_code, alias, kind, currency, last4, credit_limit_minor, statement_day, payment_day)
    values (u, 'BCP', 'Visa BCP', 'credit', 'PEN', '4821', 800000, 10, 5) returning id into card;
  insert into public.cards (user_id, institution_code, alias, kind, currency, last4) values (u, 'BBVA', 'Débito BBVA', 'debit', 'PEN', '1234');
  -- Last statement: cut on the 10th, due on the 5th of the next month.
  cut := case when lt >= m0 + 9 then m0 + 9 else (m0 - interval '1 month')::date + 9 end;
  insert into public.card_statements (user_id, card_id, currency, cut_date, due_date, billed_minor, minimum_minor)
    values (u, card, 'PEN', cut, (date_trunc('month', cut) + interval '1 month')::date + 4, 185000, 12000);

  -- What the person declared: income, fixed payments, debts, budgets, settings, balances.
  insert into public.expected_incomes (user_id, name, currency, amount_minor, amount_status, frequency, day_of_month) values
    (u, 'Sueldo', 'PEN', 450000, 'confirmed', 'monthly', 28), (u, 'Freelance', 'USD', 30000, 'estimated', 'monthly', 10);
  insert into public.fixed_expenses (user_id, name, kind, currency, amount_minor, amount_status, due_day) values
    (u, 'Alquiler', 'rent', 'PEN', 120000, 'confirmed', 1), (u, 'Celular', 'phone', 'PEN', 5900, 'confirmed', 5),
    (u, 'Tarjeta Visa BCP', 'card', 'PEN', 12000, 'estimated', 5), (u, 'Netflix', 'subscription', 'PEN', 4490, 'confirmed', 7),
    (u, 'Agua', 'services', 'PEN', 5000, 'estimated', 15), (u, 'Luz', 'services', 'PEN', 13000, 'estimated', 18),
    (u, 'Internet', 'internet', 'PEN', 9900, 'confirmed', 20);
  insert into public.fixed_expenses (user_id, name, kind, currency, amount_minor, frequency, anchor_month, due_day) values (u, 'SOAT', 'insurance', 'PEN', 18000, 'yearly', 3, 15);
  insert into public.debts (user_id, name, lender, currency, principal_minor, balance_minor, annual_rate_bp, installment_minor, installments_total, installments_paid, due_day) values
    (u, 'Tarjeta Visa BCP', 'BCP', 'PEN', 185000, 185000, 6500, null, null, 0, 5),
    (u, 'Préstamo vehicular BCP', 'BCP', 'PEN', 3500000, 2240000, 1450, 95000, 48, 18, 12),
    (u, 'Préstamo Tío Jorge', 'Tío Jorge', 'PEN', 100000, 60000, null, null, null, 0, null);
  insert into public.budgets (user_id, category_id, amount_minor) values (u, c_food, 120000), (u, c_tr, 30000), (u, c_fun, 20000);
  insert into public.planning_settings (user_id, currency, essentials_monthly_minor, cushion_minor) values (u, 'PEN', 150000, 30000);
  insert into public.balance_snapshots (user_id, currency, amount_minor) values (u, 'PEN', 385000), (u, 'USD', 42000);

  -- Six months of movements (oldest month first); only dates up to today. Amounts vary by month, deterministically.
  for m in 0..5 loop
    for dy, k, amt in
      select x.day, x.kind, x.minor from (values
        (1, 1, 120000), (5, 2, 5900), (7, 3, 4490), (15, 4, 4500 + m * 250), (18, 5, 12000 + m * 900), (20, 6, 9900),
        (12, 7, 95000), (25, 8, 140000 + m * 7000), (28, 9, 450000), (3, 10, 20000), (8, 11, 50000), (10, 12, 26000),
        (2, 13, 18500 + m * 400), (9, 14, 21300 - m * 300), (16, 15, 17800 + m * 600), (23, 16, 24100 - m * 200),
        (4, 17, 6800), (11, 18, 9500 + m * 150), (19, 19, 5400), (26, 20, 12800), (6, 21, 1800), (13, 22, 2500), (21, 23, 3200), (27, 24, 1500),
        (14, 25, 4200 + m * 100), (22, 26, 15000), (17, 27, 3500)
      ) x(day, kind, minor)
    loop
      d := (m0 - make_interval(months => 5 - m))::date + dy - 1;  -- every day used is <= 28: valid in any month
      continue when d > lt;
      n := n + 1;
      insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, institution_code, card_last4, merchant_raw, merchant_normalized, category_id, status, confidence, fingerprint)
      select u, least((d + time '12:00') at time zone 'America/Lima', now() - interval '1 minute'), t.type::public.transaction_type, t.dir::public.transaction_direction, amt, t.cur::public.currency_code,
        t.inst, t.last4, t.merchant, t.merchant, t.cat, 'confirmed', 'high', 'demo-' || m || '-' || k
      from (values
        (1, 'expense', 'outflow', 'PEN', 'BBVA', null, 'ALQUILER DEPARTAMENTO', c_home),
        (2, 'expense', 'outflow', 'PEN', 'BBVA', null, 'CLARO PERU', c_serv),
        (3, 'credit_card_purchase', 'outflow', 'PEN', 'BCP', '4821', 'NETFLIX.COM', c_fun),
        (4, 'expense', 'outflow', 'PEN', 'BBVA', null, 'SEDAPAL', c_serv),
        (5, 'expense', 'outflow', 'PEN', 'BBVA', null, 'LUZ DEL SUR', c_serv),
        (6, 'expense', 'outflow', 'PEN', 'BBVA', null, 'MOVISTAR INTERNET', c_serv),
        (7, 'expense', 'outflow', 'PEN', 'BCP', null, 'CUOTA PRESTAMO VEHICULAR', c_other),
        (8, 'credit_card_payment', 'outflow', 'PEN', 'BCP', '4821', 'PAGO TARJETA VISA BCP', null),
        (9, 'income', 'inflow', 'PEN', 'BBVA', null, 'HABERES EMPRESA SAC', null),
        (10, 'withdrawal', 'outflow', 'PEN', 'BBVA', null, 'RETIRO CAJERO BBVA', null),
        (11, 'internal_transfer', 'neutral', 'PEN', 'BBVA', null, 'TRANSFERENCIA A AHORROS BCP', null),
        (12, 'deposit', 'inflow', 'USD', 'INTERBANK', null, 'PAGO CLIENTE FREELANCE', null),
        (13, 'credit_card_purchase', 'outflow', 'PEN', 'BCP', '4821', 'PLAZA VEA', c_food),
        (14, 'credit_card_purchase', 'outflow', 'PEN', 'BCP', '4821', 'TOTTUS', c_food),
        (15, 'expense', 'outflow', 'PEN', 'BBVA', '1234', 'METRO', c_food),
        (16, 'credit_card_purchase', 'outflow', 'PEN', 'BCP', '4821', 'WONG', c_food),
        (17, 'credit_card_purchase', 'outflow', 'PEN', 'BCP', '4821', 'RESTAURANTE LA LUCHA', c_food),
        (18, 'credit_card_purchase', 'outflow', 'PEN', 'BCP', '4821', 'PARDOS CHICKEN', c_food),
        (19, 'expense', 'outflow', 'PEN', 'BBVA', '1234', 'STARBUCKS', c_food),
        (20, 'credit_card_purchase', 'outflow', 'PEN', 'BCP', '4821', 'CINEPLANET', c_fun),
        (21, 'expense', 'outflow', 'PEN', 'BBVA', '1234', 'UBER TRIP', c_tr),
        (22, 'expense', 'outflow', 'PEN', 'BBVA', '1234', 'CABIFY', c_tr),
        (23, 'expense', 'outflow', 'PEN', 'BBVA', '1234', 'UBER TRIP', c_tr),
        (24, 'expense', 'outflow', 'PEN', 'BBVA', '1234', 'METROPOLITANO', c_tr),
        (25, 'expense', 'outflow', 'PEN', 'BBVA', '1234', 'INKAFARMA', c_health),
        (26, 'expense', 'outflow', 'PEN', 'BBVA', '1234', 'SMART FIT', c_pers),
        (27, 'credit_card_purchase', 'outflow', 'USD', 'BCP', '4821', 'AMAZON.COM', c_other)
      ) t(kind, type, dir, cur, inst, last4, merchant, cat)
      where t.kind = k;
    end loop;
  end loop;

  -- A refund, items to review, and a possible duplicate (this month, before today).
  insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, institution_code, card_last4, merchant_raw, merchant_normalized, category_id, status, confidence, fingerprint) values
    (u, now() - interval '20 days', 'refund', 'inflow', 8000, 'PEN', 'BCP', '4821', 'DEVOLUCION SAGA FALABELLA', 'DEVOLUCION SAGA FALABELLA', c_other, 'confirmed', 'high', 'demo-refund'),
    (u, now() - interval '3 days', 'expense', 'outflow', 6490, 'PEN', 'BCP', '9999', 'TAMBO', 'TAMBO', c_other, 'review_required', 'medium', 'demo-review-1'),
    (u, now() - interval '2 days', 'unknown', 'outflow', 35000, 'PEN', 'BBVA', null, 'YAPE A JUAN P', 'YAPE A JUAN P', null, 'review_required', 'low', 'demo-review-2');
  insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, institution_code, card_last4, merchant_raw, merchant_normalized, category_id, status, confidence, fingerprint)
    values (u, now() - interval '1 day', 'credit_card_purchase', 'outflow', 4200, 'PEN', 'BCP', '4821', 'PARDOS CHICKEN', 'PARDOS CHICKEN', c_food, 'confirmed', 'high', 'demo-dup-a') returning id into ta;
  insert into public.transactions (user_id, occurred_at, type, direction, amount_minor, currency, institution_code, card_last4, merchant_raw, merchant_normalized, category_id, status, confidence, fingerprint, duplicate_of_id)
    values (u, now() - interval '1 day' + interval '3 minutes', 'credit_card_purchase', 'outflow', 4200, 'PEN', 'BCP', '4821', 'PARDOS CHICKEN', 'PARDOS CHICKEN', c_food, 'possible_duplicate', 'high', 'demo-dup-b', ta);

  insert into public.transaction_sources (user_id, transaction_id, channel, external_event_id, parser_version, received_at)
    select user_id, id, 'manual', 'm-' || fingerprint, 'MANUAL', occurred_at from public.transactions where user_id = u;
  raise notice 'demo account % created with % monthly movements', em, n;
end $$;
