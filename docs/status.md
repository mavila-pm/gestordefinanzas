# Status — current state (not a diary: history lives in git + ADRs)

States: IMPLEMENTED · VERIFIED (reproducible evidence at the level `docs/qa.md` requires) · APPROVED (PO).
Branch `claude/beautiful-keller-ikxlrj` (PR mavila-pm/gestordefinanzas#1, Vercel Preview per push). Supabase `jeloegnvaxlfqjntbbyy`,
migrations applied through `20261010000039` (`…035` login_throttle_purge PENDING: contains DELETE, PO applies it in SQL Editor).

## Checkpoint (2026-10-10)
Unit 432 · DB 130 · build OK · CI green. Last full E2E: 2026-09-29 (289/289, visual 162 shots, perf 8/8); later blocks
updated E2E copy without a full run (no E2E credentials in the agent environment).

## Product areas (all VERIFIED unless noted; detail in the ADRs and `docs/architecture/structure.md`)
| Area | ADR | Open (PO / external) |
|---|---|---|
| Auth: email-first signup, password 12+, profile (+51 phone, one phone and one email per account, 18+), versioned legal acceptance, login lockout, recovery, change password | — | Paste email templates + SMTP; 'Secure password change' + Reauthentication template; apply `…035`; one phone on 2 real accounts (PO picks) |
| Movements: manual, review queue, splits, dedupe (L1–L3), learning rules, card auto-link, CSV export, Free history window | 0002–0004, 0012 | Real BCP samples (templates SYNTHETIC_UNVERIFIED) |
| Imports: pasted BCP notifications; Email Bridge webhook | — | Email Bridge: inbound provider, domain + MX, secrets (PARTIALLY VERIFIED) |
| Dinero libre: planning engine, próximos pagos, ¿puedo gastar?, observed vs planned, recurrence lifecycle, scenarios, applied plans, card statements | 0005, 0007, 0008, 0010, 0013, 0014 | Reminder delivery needs a provider |
| Plans/limits: Free caps in SQL (auto movements, institutions, history), trial/Plus | — | Billing provider + price |
| Onboarding with Vels: one question per turn, one payment at a time (amount → day), 'no pago X' declined, quincena clarification, cards and loans (existing `debts` columns, balance never computed), agenda to next income | 0006 | PO walkthrough; decide: loan with installment but unknown balance is deferred (its installment is not planned yet) |
| Vels: local intents + engine answers, social turns, progressive collect (balance → income), Gemini route for the rest, chat that scrolls like a messaging app, avatar + "Vels ✓ · Conectada" | 0011, 0015 | Real Gemini call NOT VERIFIED from this environment (key only in Vercel); PO reads 20 turns in Preview |
| AI: Gemini only (`aiModel()`), one door `lib/ai.ts` (quota → call → record, ≤ 1 retry), validated output, cost ceiling until `AI_PRICES` | 0006, 0015 | `AI_PRICES` with Gemini's published rate; privacy text still names old providers (needs a new legal version) |
| Design system, motion, Manrope subset, UX writing pass, Resumen redesign | — | PO feel check on a phone |
| Product UX pass (2026-10-10): Resumen at a glance ('Hola, Mauro.' · 'Tu dinero, más claro.', + Registrar movimiento → Vels or manual, Dinero disponible, fixed payments, próximos pagos, savings goal, 6-month chart, cards and loans, recent movements; no tutorials); Dinero libre → Dinero disponible (simulators, '¿Y si…?', 'Aplicar plan' UI removed: Vels asks/simulates/applies with the same engines); own categories (labels only); simple Por revisar; Próximos pagos in Próximos / Recurrentes / Tarjetas y préstamos; Análisis as a deep dashboard; Presupuestos → Límites de gasto; savings goal (migration 038); nav by product hierarchy, Por revisar only with a count; 'Lo que Velsuno recuerda' removed (rules keep working; 'Deshacer' moved to Próximos pagos) | — | PO walkthrough; E2E specs updated to the new UI, not run here (no E2E credentials) |
| Ajustes (2026-10-10): avatar → /app/ajustes (sidebar foot / mobile topbar); 9 sections Perfil, Plan y uso, Vels, Finanzas, Apariencia, Notificaciones, Accesibilidad, Seguridad, Privacidad y datos (desktop sidebar + content, mobile list → screen). Account prefs in `user_preferences` (039): Vels style (presentation only) + proactive note, primary currency/account (defaults/order, no conversion), notice toggles (filter Resumen notices only). Device prefs in cookies: mode, text size, reduce motion. 'Uso de Vels' % = ai_usage / plan_config (no limit → no %), resets 1st of next Lima month. Removed from nav: Tu plan (`/app/cuenta` → `/app/ajustes/plan`), Conexiones (reached through Vels: 'quiero conectar mi correo'). Not shown, by design: second accent (only Cítrico approved), Fondo (= Modo), Mayor contraste (no tokens), Mostrar centavos (needs a display layer over `formatMoney`), ciclo financiero (Dinero disponible already runs to next income), session list (only 'Cerrar otras sesiones'), last password change (not stored), Seguridad notice (no consumer). Delete account = request to support | — | PO walkthrough; 36/36 local Playwright checks (390×844 + 1280, light/dark) |

## Blockers / decisions (external)
- Gemini: open Vels on the Preview and ask something outside the local rules ("¿me da para unas zapatillas de 300?");
  then `scripts/ai-bench.ts gemini` (synthetic data). MVP priorities: `docs/MVP.md`.
- Email Bridge real integration; billing provider/price/periodicity; custom SMTP before launch; leaked-password protection.
- Known debt: user-owned categories; direct-edit policy for cards/accounts/budgets/debts (ADR-0003).

## Next work (no external decision needed)
1. Partial payments on obligations and sinking funds (named reserves) in the planning engine.
2. Local reading of "debo en dos tarjetas: bcp 1,200 y bbva 800" (ai-bench t27: read as a loan today).
3. Copy pass on older screens (Reglas, Conexiones, Importar).

PO manual checklist: `docs/runbooks/acceptance-checklist.md`.
