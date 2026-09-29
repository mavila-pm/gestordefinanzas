---
paths:
  - "app/**/*.tsx"
  - "components/**"
  - "app/globals.css"
---
# UI rules (Velsuno)
- Design system: `brand/VELSUNO/` tokens via `app/globals.css`; no raw hex; logo only via `components/ui/logo.tsx`.
- Financial logic never in React components: call `src/engine` / `src/domain` / server actions.
- Mobile-first (375–390 px), no horizontal overflow, 44 px targets, labels on inputs, focus visible, reduced motion.
- Copy: short, plain, direct, friendly. Title 1–5 words, button 1–3, help 1 short sentence, error = what + action.
  Brief ≠ vague: always keep amount, currency, date, status ("estimado", "por confirmar"). No AI/SaaS template look.
- Progressive disclosure: main figure first, detail on demand.
- Every tap gives feedback < 100 ms (pressed state, `useLinkStatus`, busy form, optimistic echo of the user's own
  words only). Never optimistic for payments, incomes or other financial confirmations.
- A route with `notFound()` must not get a `loading.tsx` above it (streaming would return 200, not 404).
- Measure before optimizing: `scripts/e2e.sh perf`; visual QA: `scripts/e2e.sh visual`.
