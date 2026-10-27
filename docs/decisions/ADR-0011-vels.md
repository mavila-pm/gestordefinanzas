# ADR-0011 — Vels: the conversational interface of the same financial core

Status: ACCEPTED · Date: 2026-09-28 · No migration.

**Naming.** Assistant: **Vels** ("la inteligencia financiera personal de Velsuno"). Main CTA / aria-label: **"Hablar con
Vels"**. Nav label and page title: "Vels". Placeholder: "Escríbele a Vels". One CTA only (no "Chatear/Consultar/
Pregúntale" variants): fewer names, less inconsistency. Never "Chat", "Asistente" or "IA" as the name. Mark: a plain
"V" in the brand action color — no robot, sparkle, gradient or new logo.

**Architecture.** conversation → deterministic interpreter (`detectIntent`) → planning engine / scenarios → answer →
optional action. The model only phrases what no rule covers (quota via `lib/ai.ts`). One thread (`assistant`), one
set of server actions (`app/app/preguntar/actions.ts`), one engine: the bubble and the full page (`/app/preguntar`,
route kept for existing links) are two views of it. Dashboard changes are read fresh on every open (`velsOpen`).

**Actions by class.** A read-only (free, organize, card limit, why) · B simulation (what-if, pay debt, delay; never
writes) · C proposal (owe, estimate basics, preference, camera facts: text says what will change) · D confirmation
required (buttons → deterministic server writes, validated, RLS, logged in `learning_events`, idempotent) · E never
(bank payments, transfers, marking paid without evidence). "Tengo que pagarle S/1,000 a mi pareja" creates a pending
debt, never a payment.

**Card operating limit.** Bank limit ≠ user's budget. Operating limit (PROPUESTO) = today's free money until the next
income (what can be paid in full without touching planned payments), labelled "estimado" when the plan is partial.
Card cycle (`cardCycle`): from `cards.statement_day/payment_day` (set in Tarjetas → Ciclo) Vels says when the billed
balance is due (pay the total → no interest) and when a purchase made today is paid.

**UX.** Floating 56 px button bottom-right (above the bottom nav on mobile, safe areas); native `<dialog>` (focus trap,
Escape, backdrop click); opens before any fetch (measured < 100 ms) and loads messages + ≤3 openers after. Mobile:
full screen, `interactive-widget=resizes-content` so the composer stays above the keyboard. Desktop: 400 px panel.
Openers come from real state first (income received, card due soon, several payments) then the current screen.

**Estimates.** "Pongámosle S/500 en comida" is saved with `planning_settings.essentials_status = 'estimated'` (migration
000023): same numbers, plan stays "estimado". A debt saved from Vels without a date is not placed in Dinero libre (no
invented date) and Vels says so.

**Not done.** "Aplicar plan" (persisted reservations) needs a reservations model — pending product decision.
Billed vs post-cut split needs statement amounts (camera/import).
