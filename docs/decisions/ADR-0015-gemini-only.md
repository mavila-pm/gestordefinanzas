# ADR-0015 — Gemini as the only AI provider

Date: 2026-10-08 · Status: accepted (PO request) · Supersedes the provider choice in block 040 (OpenRouter/DeepSeek).

## Decision
- One provider for the MVP: Gemini through the official SDK `@google/genai` (`src/ai/gemini.ts`). Model ID in one
  place: `GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash'` (`src/ai/config.ts`), overridable with `GEMINI_MODEL`. Key `GEMINI_API_KEY`,
  server only. OpenRouter/DeepSeek adapters, the fallback chain and `generalAIConfig` are removed.
- Vels: local rules first (0 AI cost). Unrecognised → Gemini returns a structured route (`VELS_ROUTE_SCHEMA`, enforced with
  `responseJsonSchema`) → `validateVelsRoute` (enum intents, amount + currency must be read in the question by the local parser `findAmounts`, free replies may only repeat
  numbers present in the state or question) → the existing engine (`answer()`) computes. Invalid → recorded as invalid_output,
  friendly fallback with suggested questions.
- Same door as before (ADR-0006): ai_reserve → provider → ai_record; ≤ 1 retry (timeout, 5xx, 429); 4xx/empty/invalid final;
  SDK retries off. Errors never carry the provider's text. No prompt or answer is logged.
- Gemini 3.x request shape: thinkingLevel LOW minimum (MINIMAL is refused), no sampling parameters, maxOutputTokens floor
  1024 because thinking counts inside it (caps 1024–8192 per operation). Failures log only kind, status, model, latency.
- Unpriced model → costed at `UNPRICED_CEILING` (a guard, not a price) until `AI_PRICES` carries the published rate.

## Consequences
Simpler config and one privacy review (Gemini terms: use the paid tier so prompts are not used for training). A Gemini outage
means deterministic-only Vels, never a broken thread.

## Amendment 2026-10-10 — no provider abstraction left
- `AIProvider`/`ProviderName`/`providerFor()` and the provider switch are gone. `src/ai/model.ts` holds the call types and a
  small `AIModel` shape; `aiModel()` (`src/ai/config.ts`) returns Gemini when `GEMINI_API_KEY` is set, otherwise null (Vels
  stays deterministic). `AI_PROVIDER` and `AI_ALLOW_FIXTURE` are no longer read.
- The canned fixture is test support (`src/ai/test-fixture.ts`): unit tests inject it directly; E2E starts `next start` with
  `AI_FIXTURE=1` (ignored on any Vercel deployment: Preview or production).
- The temporary test surface `/app/prueba-ia` + `POST /api/ai/chat` (`generateAIResponse`, `AI_TEST_ENDPOINT`) is removed:
  Gemini is verified through Vels itself.
