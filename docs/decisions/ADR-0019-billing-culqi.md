# ADR-0019 — Billing with Culqi (BillingProvider, card checkout, lifecycle)

(Numbered 0019: ADR-0018 is the security-headers decision of another front.)

Status: proposed (2026-10-22; security review applied the same day). Code complete behind switches; **no real charge is possible** until the owner sets the
env vars (runbook `docs/runbooks/billing-culqi.md`) and the PO approves the two items under "Needs the PO".

## Context
Spec §77/§84–87: Plus is sold as Mensual (US$ 4, US$ 9 from 2027-01-01 Lima), Anual (US$ 59) and Vitalicio (US$ 198),
prices from `billing_price()` (migration 046, unchanged). Peru-first → Culqi. Preview and Production share ONE
Supabase project, so a sandbox charge must never grant real Plus. Culqi does not sign webhooks.

## Decision
**Layers.** `src/billing/provider.ts` (BillingProvider: typed results, never throws for a provider answer) ·
`src/billing/culqi.ts` (pure: paths, id patterns, fixed-schema validators, error mapping, webhook parsing, Basic
auth) · `src/billing/culqi-client.ts` (HTTP over an injectable fetch: Bearer secret, 10 s timeout, **no retry** on
money calls, responses capped at 256 KB, ids checked by kind + mode before they reach a URL, logs = op/status/code
only) · `src/billing/checkout.ts` (flows) · `src/infrastructure/billing/*` (Postgres store over `DATABASE_URL`,
webhook handler) · `lib/culqi.ts` / `lib/billing.ts` (server-only wiring; the secret is read only there).
`src/billing/culqi-public.ts` is the only Culqi module a client component imports (script URL, CSP origins).

**Money rules.** The amount charged is always the order amount stored by `billing_create_order` and returned by
`billing_begin_charge` (pending → processing, once): the browser only names the plan and the price it saw
(`price_changed`). Plus is granted only by SQL (`billing_activate`, `billing_activate_subscription`), which re-checks
owner, amount, currency, mode, trial length and date bounds. Outcomes: definitive "no" → `billing_fail_order`;
unknown (timeout, 5xx, unreadable 2xx) → the order stays `processing` (webhook settles it; never "failed" while money
may have moved); charged but not activatable → refund (or `needs_refund` in the ledger when the refund fails).
A `processing` order blocks every new order of that person **at any age** (`payment_in_progress`): a result that
never came is reconciled by support (runbook §7), never paid twice.

**One live subscription per person.** `billing_renewal_open()` (SQL) ≡ `renewalStillOpen()` (TS): a Mensual/Anual
with a provider reference, not cancelled, not closed — also when it no longer gives Plus (a lapsed `past_due`, which
Culqi may still charge). While it holds, `billing_create_order` / `billing_begin_charge` refuse
(`subscription_still_open`) and neither activation function overwrites the row: the person cancels it first
(Ajustes → Plan y uso shows a lapsed renewal and its "Cancelar renovación"; the payment page says why it is blocked).
A refused Vitalicio activation is refunded; a refused subscription is cancelled at Culqi.

**Flows.** Vitalicio: Culqi Checkout Custom tokenizes the card in Culqi's window (card only, USD) → server charges
`POST /v2/charges` with `metadata.order_id` → activation. Mensual/Anual: `GET /recurrent/plans/{id}` must match amount,
currency, interval and trial days **before anything is created** → customer (one per person and mode, reused;
address asked, never invented) → `POST /cards` → `POST /recurrent/subscriptions/create {card_id, plan_id, tyc: true,
metadata}` → activation with **Culqi's** trial end / next billing date. A subscription that does not match what was
accepted is deleted at Culqi at once, and its order is closed WITH the subscription reference so every later event
of it is attributed (cancel retried, charges refunded). A no-trial plan must have **no** initial cycles at all (a first
cycle at another price or free cycles of another unit is a mismatch). No-trial plans stay unconfigured (purchase off)
until the sandbox confirms how their first charge is reported (runbook §4.5–4.6).

**Test/live guard** (`src/billing/config.ts`). Outside `VERCEL_ENV=production` only `pk_test_`/`sk_test_`; in
Production only `pk_live_`/`sk_live_`; both keys of one mode. Any mismatch → billing disabled with a logged reason
(`billing_disabled`), never "on" by default. Test mode is offered to demo accounts only and SQL refuses a test charge
for anyone else (`test_mode_demo_only`). Orders, subscriptions and customers record `livemode`; the webhook ignores
objects of the other mode; "Cancelar renovación" only runs with keys of the subscription's mode.

**Plans per price (2027 guard).** One Culqi plan id per (plan, amount, trial): `CULQI_PLAN_MONTHLY_400_TRIAL`,
`…_400`, `…_900_TRIAL`, `…_900`, `CULQI_PLAN_ANNUAL_5900_TRIAL`, `…_5900`. The order amount picks the plan; a missing or
mismatching plan disables that purchase (fail closed). Culqi plan amounts cannot be changed (confirmed: PATCH has no
amount), so subscribers keep the price they accepted; renewals must equal `subscriptions.billing_amount_minor`.
Moving US$ 4 subscribers to US$ 9 is a PO decision (notice + new subscription), not code.

**One entitlement rule.** `billing_plan_state()` (SQL) ≡ `planState()` (TS), parity-tested row by row: trial until
its end; Vitalicio forever (full refund → canceled); Mensual/Anual until the paid period ends, plus
`plan_config.billing_grace_days` (3, PROPUESTO) while a renewal is expected (`past_due` included); cancelled at period
end → exactly until the period end. No period end → Free (fail closed). Data is never deleted by payment state.

**Webhook** `POST /api/billing/culqi`: 503 until keys + `CULQI_WEBHOOK_USER`/`CULQI_WEBHOOK_PASSWORD` (≥ 24) +
`DATABASE_URL`; HTTP Basic compared in constant time; 64 KB cap; the body is a hint (event type + object id) — the
object is **re-fetched with the secret key** and only Culqi's copy is acted on; one receipt per delivery in
`billing_events (provider, event_ref)` plus per-reference idempotency inside every SQL function; 500 on transient
errors (receipt stays open, Culqi retries). It also heals a lost checkout answer (subscription metadata carries the
order id). It works with `CULQI_ENABLED=false`: renewals, refunds and cancellations of existing subscribers never stop.
- **Periods only from charges.** A renewal is recorded only from a re-fetched successful charge (amount = the amount
  sold, period = Culqi's next billing date). A subscription event never grants a period and never turns `past_due`
  into `active`.
- **Routing.** A charge that names a subscription, or carries the order of a Mensual/Anual, is a period charge — never
  a Vitalicio settlement. One whose subscription is still being activated (order `processing`) answers 500 (retried).
- **Charges no row holds** (`billing_flag_charge`): a successful charge of a subscription no `subscriptions` row holds
  is recorded once as `needs_refund` (`orphan:<charge>`). When it is provably ours (an order closed with that
  subscription, or its cancellation in the ledger) the subscription is cancelled again and the charge refunded once;
  otherwise the owner reviews it (no automatic refund of a charge nothing links to Velsuno). A refused subscription's
  later events retry its cancellation.

**Cancel** (Ajustes → Plan y uso): `DELETE /recurrent/subscriptions/{id}` first, then `billing_cancel` (Plus until the
period/trial end, then Free). If Culqi fails nothing changes and the person is told so. A DELETE answered 404 counts
only when a GET confirms 404 (UNVERIFIED how Culqi shows a cancelled subscription: fail closed). Vitalicio has no
cancel.

## Not built (documented)
- **Daily reconciliation job** (skipped in this block). Design: Vercel cron → `app/api/cron/billing-reconcile`
  (503 without `CRON_SECRET`, 401 on a wrong bearer); re-fetch subscriptions within ±2 days of
  `current_period_end` or `past_due` and apply the same SQL lifecycle functions; for `processing` orders older than
  10 min, find the Culqi charge by `metadata.order_id` and activate/fail/refund through `settleCharge`. Until it
  exists, a lost webhook can leave a paying subscriber on Free after period end + grace (see risks).
- Card update for `past_due`, refunds started from Velsuno (the owner refunds in CulqiPanel; the webhook records it),
  3-D Secure (`needs_3ds` → fixed message, no charge), SUNAT receipts, chargebacks (no confirmed Culqi event).

## Needs the PO
1. **Change Request (Anexo A)** — spec §85/§86 ask for *signed* webhooks with timestamp/replay protection. Culqi
   does not sign them. Proposed equivalent: Basic credentials + server-side re-fetch of the object (the body is never
   trusted, so a forged or replayed event has no effect beyond a re-fetch) + idempotency ledger. Also: §85 states
   `grace_period` = `past_due` within `billing_grace_days`; `cancel_at_period_end` = a flag; `suspended` not used
   (Free after grace). Both need the PO's CR before live.
2. **Terms** — `/terminos` (2026-10-08) says "Hoy Velsuno no realiza cobros". Live sales stay off in code
   (`TERMS_COVER_BILLING = false` in `src/web/legal.ts`) until a new Terms version with the charges, renewal,
   cancellation and refund policy is approved and published; the sandbox works without it.

## UNVERIFIED (official docs unreachable from the build sandbox; confirm in the sandbox run)
Confirmed from the official SDK source (culqi-php master, read 2026-10-22): base URLs, `/recurrent/plans` and
`/recurrent/subscriptions` paths and bodies, 25-char ids, refund reasons, plan intervals 1..6, PEN/USD. Unverified:
key prefixes, `outcome.type = 'venta_exitosa'`, interval meanings (1 day, 3 month, 4 year), how a free trial is
expressed (`initial_cycles`), subscription fields (`trial_end`, `next_billing_date`, `active_card`, status codes),
timestamps in ms, webhook body/types and Basic auth, `action_code: REVIEW` for 3DS, `?email=` customer filter,
`validate: true` on cards, `amount_refunded`, `metadata.subscription_id` (or our `order_id`) on period charges, how a
cancelled subscription answers GET (404 or a status), Checkout v4 JS API, CSP origins. Each is marked `// UNVERIFIED` in code and listed in the runbook checklist.

## Consequences
- Going live = owner env vars + plans + webhook (runbook) + the two PO items above. No other code change.
- Risk accepted until the reconciliation job exists: renewals rely on Culqi **charge** webhooks whose link to the
  subscription (`metadata.subscription_id` or the order id) is unverified. If neither is present, renewals are never
  recorded and a paying subscriber falls to Free after period end + grace (fail closed: never Plus without a
  payment); the sandbox run (§4.6) must confirm it before live.
