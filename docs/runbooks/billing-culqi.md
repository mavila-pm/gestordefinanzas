# Runbook — Culqi billing (owner steps, sandbox acceptance, go-live)

Design and decisions: `docs/decisions/ADR-0019-billing-culqi.md`. Nothing here is done by an agent: keys, plans and
webhook credentials exist only in the owner's CulqiPanel and Vercel. Never paste a key in chat, git or a ticket.

## 0. What is already in the code
- Payments are **off** until `CULQI_ENABLED=true` + valid keys; every misconfiguration logs `billing_disabled` with a
  reason (Vercel → Logs, search `billing_disabled`): `not_enabled`, `missing_keys`, `bad_key_format`,
  `key_mode_mismatch`, `live_key_outside_production`, `test_key_in_production`, `missing_database_url`,
  `terms_without_billing`, `missing_webhook_credentials`, `weak_webhook_password`. Plan ids that are malformed or of
  the other mode log `billing_plan_config` (`CULQI_PLAN_…:bad_plan_id`).
- Preview (test keys) sells **only to demo accounts**; real accounts see "Los pagos con tarjeta se habilitarán muy
  pronto". Production (live keys) sells to real accounts once the new Terms are published (`TERMS_COVER_BILLING`).
- Rollback at any time: `CULQI_ENABLED=false` + redeploy stops new sales; webhook, renewals and "Cancelar renovación"
  keep working for existing subscribers.

## 1. Database (once, before any env var)
Apply `supabase/migrations/20261020000054…56` to project `jeloegnvaxlfqjntbbyy` in order (SQL Editor or
`supabase db push`), after `npm run test:db` is green on the same commit. Verify:
```sql
select relname, relrowsecurity from pg_class where relname in ('billing_events','billing_customers');      -- true, true
select has_table_privilege('authenticated','public.billing_events','select'),
       has_function_privilege('authenticated','public.billing_activate(uuid,text,text,bigint,text)','execute'),
       has_function_privilege('authenticated','public.billing_begin_charge(uuid,uuid,text,boolean)','execute'),
       has_function_privilege('authenticated','public.billing_flag_charge(text,text,text,bigint,text,boolean,text)','execute'); -- false ×4
```
Then add the 054–056 rows to the applied table in `docs/runbooks/supabase-migrations.md`.

## 2. Culqi account (CulqiPanel, integration environment first)
1. Confirm the business is approved or in integration mode; ask Culqi to enable **USD charges** and
   **Suscripciones / cargos recurrentes** (orders are USD only).
2. Desarrollo → API Keys (integration): copy `pk_test_…` and `sk_test_…`.
3. Create six plans in **USD** (Panel → Planes, or `POST /v2/recurrent/plans/create` with `sk_test`). Amounts in
   cents, exactly `billing_price()`; interval `interval_unit_time` 3 = month, 4 = year (UNVERIFIED: check the panel
   labels); `interval_count` 1:

   | Env var | Plan | amount | interval | free trial (`initial_cycles`) |
   |---|---|---|---|---|
   | `CULQI_PLAN_MONTHLY_400_TRIAL` | Velsuno Plus Mensual (prueba) | 400 | month | count 14, unit day (1), amount 0, has_initial_charge false |
   | `CULQI_PLAN_MONTHLY_400` | Velsuno Plus Mensual | 400 | month | none (count 0, has_initial_charge false) |
   | `CULQI_PLAN_MONTHLY_900_TRIAL` | Velsuno Plus Mensual 2027 (prueba) | 900 | month | count 14, day, amount 0 |
   | `CULQI_PLAN_MONTHLY_900` | Velsuno Plus Mensual 2027 | 900 | month | none |
   | `CULQI_PLAN_ANNUAL_5900_TRIAL` | Velsuno Plus Anual (prueba) | 5900 | year | count 14, day, amount 0 |
   | `CULQI_PLAN_ANNUAL_5900` | Velsuno Plus Anual | 5900 | year | none |

   The 14 must equal `plan_config.trial_days`; the server compares the plan Culqi returns with the order (amount,
   currency, interval, trial days; a no-trial plan must have no initial cycles) and refuses the purchase on any
   difference (`billing_plan_mismatch` in the logs). **Create the three no-trial plans but leave their env vars empty**
   until §4.5 and §4.6 pass: empty = no-trial Mensual/Anual off (only people who already used their trial need them).
   If the panel cannot express a 14-day free start, tell engineering (fallback: save the card now, subscribe at the
   trial end — not built). The 900 plans are needed only from 2027-01-01 (Lima); without them Mensual is off then.
4. Eventos → Webhooks (integration): URL
   `https://<stable Preview branch alias>/api/billing/culqi?x-vercel-protection-bypass=<secret>` — the secret from
   Vercel → Project → Settings → Deployment Protection → **Protection Bypass for Automation**. Events: every charge,
   refund and subscription event the panel lists (at least `charge.creation.succeeded`, `charge.creation.failed`,
   `refund.creation.succeeded`). Turn on **Activar autenticación**: username ≤ 20 characters, password ≥ 24 random
   characters (`openssl rand -base64 32`).

## 3. Vercel env vars (Preview scope first), then redeploy
| Name | Value | Notes |
|---|---|---|
| `CULQI_PUBLIC_KEY` | `pk_test_…` (Preview) / `pk_live_…` (Production) | handed to the page by the server; still set as a server var |
| `CULQI_SECRET_KEY` | `sk_test_…` / `sk_live_…` | secret, server only |
| `CULQI_PLAN_MONTHLY_400_TRIAL` … `CULQI_PLAN_ANNUAL_5900` | `pln_test_…` / `pln_live_…` | the six names above; mode must match the keys; the no-trial three (`…_400`, `…_900`, `…_5900`) only after §4.5–4.6 |
| `CULQI_WEBHOOK_USER`, `CULQI_WEBHOOK_PASSWORD` | as set in CulqiPanel | password ≥ 24 chars |
| `DATABASE_URL` | Supabase → Connect → pooled connection string (Transaction mode) of `jeloegnvaxlfqjntbbyy` | secret, server only; also used by the Email Bridge |
| `CULQI_ENABLED` | `false` until §4 passes, then `true` | exact string `true` |

The old names `CULQI_PLAN_MONTHLY` / `CULQI_PLAN_ANNUAL` are ignored (one plan per price now). After the redeploy:
`curl -s -o /dev/null -w '%{http_code}' -X POST https://<alias>/api/billing/culqi?x-vercel-protection-bypass=…`
→ `401` (configured, no Basic auth); `503` means something is missing (Logs: `billing_disabled`, scope `webhook`).

## 4. Sandbox acceptance on Preview (demo account, Culqi test cards)
Use a demo account (`scripts/qa/demo-account.sh`) and Culqi's published test cards. After each step check
`/app/planes/gracias`, Ajustes → Plan y uso, `billing_orders`, `billing_events` (and CulqiPanel). Record what Culqi
actually returned: it turns each UNVERIFIED item into confirmed (update `src/billing/culqi.ts` + ADR-0019).
1. Vitalicio paid → gracias "Ya tienes Velsuno Plus Vitalicio"; order `paid`; one `chr_test_` in CulqiPanel.
2. Vitalicio with a declining card → fixed message "… No se hizo ningún cargo."; order `failed`; no Plus.
3. Mensual with trial → Plan y uso shows "Tu prueba termina el …" and "El primer cobro de US$ 4.00 será el …";
   check `subscriptions.trial_ends_at` = Culqi's date (**confirm field names: `trial_end`, `next_billing_date`,
   `active_card`, status codes**).
4. Cancel during the trial → "Conservas Plus hasta el … No se hará ningún otro cobro."; CulqiPanel shows the
   subscription cancelled; no charge at the trial end. Then `GET /recurrent/subscriptions/{id}` with `sk_test`:
   **record** whether a cancelled subscription answers 404 or 200 with a status (a repeated cancel is recorded only
   on GET 404).
5. Anual without trial (set `CULQI_PLAN_ANNUAL_5900` on Preview for this step only) → charged at creation?
   (**confirm**: a no-trial plan charges on `subscriptions/create`; the activation needs Culqi's next billing date;
   which webhook reports that first charge and whether it carries `metadata.subscription_id` or our `order_id`).
6. First period charge (or trigger a renewal in the sandbox) → **confirm** which webhook arrives and whether the
   charge carries the subscription id (`metadata.subscription_id`?) or the order id — renewals are recorded ONLY from
   charges (ADR-0019 risks). A subscription event alone never renews.
6b. Lapsed renewal: make a trial's first charge fail (declining card) and wait past the grace days (or move
   `current_period_end` back on the demo row) → Plan y uso shows "Pago pendiente" and "Cancelar renovación"; the
   payment page refuses a new plan ("Tu suscripción anterior sigue activa…") until it is cancelled.
7. Resend a webhook from CulqiPanel → answer 200 `duplicate`, no second effect.
8. A refund from CulqiPanel of the Vitalicio charge → order `refunded`, plan Free, ledger row `charge.refunded`.
9. Browser console during Checkout: list every blocked/used origin (for the CSP below); try a 3-D Secure test card
   (expected today: "Tu banco pidió una verificación adicional…", no charge).
10. Wrong keys on purpose (e.g. `sk_live_` on Preview) → payments disabled, log `live_key_outside_production`.

## 5. CSP domains Culqi needs
Velsuno sends **no Content-Security-Policy** today (`next.config.ts`: X-Frame-Options DENY only applies to our pages
being framed; Culqi opens its own iframe/modal). If a CSP is added, allow at least (UNVERIFIED beyond the first two
rows — confirm with step 4.9; source of truth in code: `CULQI_CSP` in `src/billing/culqi-public.ts`):

| Directive | Origins |
|---|---|
| `script-src` | `https://js.culqi.com` (Checkout script, confirmed), `https://3ds.culqi.com` |
| `connect-src` | `https://secure.culqi.com` (tokens, confirmed in the SDK), `https://api.culqi.com`, `https://js.culqi.com`, `https://3ds.culqi.com` |
| `frame-src` | `https://js.culqi.com`, `https://checkout.culqi.com`, `https://3ds.culqi.com` |
| `img-src` / `style-src` | `https://*.culqi.com` / `https://js.culqi.com` |

## 6. Go live (Production, owner only, at launch)
Preconditions: §4 passed and recorded; PO approved the Change Request (unsigned webhooks + §85 state mapping) and the
new Terms (charges, renewal, cancellation, refunds; Culqi named as processor in Privacidad) — engineering then
publishes them and sets `TERMS_COVER_BILLING = true`. Then repeat §2 in Culqi **production** (live keys, six live
plans, production webhook URL `https://<production domain>/api/billing/culqi` with authentication) and §3 with
**Production** scope (`pk_live_`/`sk_live_`/`pln_live_…`). Keep `CULQI_ENABLED=false`, deploy, check the webhook
answers 401, then `CULQI_ENABLED=true` and redeploy. First real purchase: the owner's own card, then a refund.

## 7. Operations
- Ledger: `select received_at, type, outcome, detail, object_ref from public.billing_events order by id desc limit 50;`
  `outcome = 'needs_refund'` = money taken that grants nothing. It is resolved when a `charge.refunded` row for the
  same charge exists (`object_ref` = the `chr_…`); otherwise refund it in CulqiPanel (the webhook records it):
  - `order.failed` with a `chr_…` (Vitalicio not activatable) — refund that charge;
  - `order.failed` with a `sxn_…` (a refused subscription without trial) — its first charge was taken at creation:
    find it in CulqiPanel under that subscription (the webhook refunds it automatically when it is reported);
  - `charge.unmatched`, detail `…:ours` — refunded automatically unless the receipt closed as `needs_refund`
    (`charge_of_unheld_subscription`): refund it by hand; detail `…:review` — a subscription nothing links to
    Velsuno: check it in CulqiPanel (its metadata `order_id`, its customer) before refunding;
  - `plan.renewed` with `charged_after_cancel` — charged after a cancellation.
  `outcome = 'received'` older than an hour = a delivery that kept failing (Culqi retries; check Logs
  `culqi_webhook_error` / `culqi_webhook_failed`).
- Orders stuck in `processing` (unknown outcome, webhook lost) block every new purchase of that person, at any age
  ("Tienes un pago en proceso… escríbenos"): find the charge in CulqiPanel by `metadata.order_id`. Charged → resend
  its webhook from CulqiPanel (it activates or refunds). Not charged → close it in the SQL editor:
  `select public.billing_fail_order('<order id>', 'reconciled_no_charge');`. The daily reconciliation job that would
  do this is not built yet (ADR-0019).
- 2027 price: from 2027-01-01 (Lima) new Mensual orders are US$ 9 and use the `_900` plans; existing subscribers stay
  on their US$ 4 plan (Culqi plan amounts are immutable) unless the PO decides a migration with notice.
