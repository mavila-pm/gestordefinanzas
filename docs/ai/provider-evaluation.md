# AI provider evaluation (ADR-0006, adenda §27-§28, §59-§61)

**Prices are a SNAPSHOT, not a source of truth.** Consulted 2026-09-28. The official pricing pages
(ai.google.dev, api-docs.deepseek.com) were blocked from the build environment, so the figures below come from
secondary sources and must be re-checked on the official pages before any commercial decision.

| Provider · model | Input / 1M | Output / 1M | Cached input / 1M | Vision | Notes |
|---|---|---|---|---|---|
| DeepSeek V4.1 Flash (`deepseek-chat`) | US$0.15 off-peak · 0.30 peak | 0.60 · 1.20 | 0.003 · 0.006 | via `deepseek-v4-flash-vision-exp` (experimental), images ≤384 tokens at Flash rates | Peak (x2): 01–04 and 06–10 UTC Mon–Fri. OpenAI-compatible API. |
| Gemini 3.5 Flash-Lite | US$0.30 (text, image, video, audio) | 2.50 | — | yes, native | Older Gemini 2.5 Flash-Lite: 0.10 / 0.40. |

Sources: [CloudZero — DeepSeek pricing](https://www.cloudzero.com/blog/deepseek-pricing/),
[BenchLM — DeepSeek API pricing (Sep 2026)](https://benchlm.ai/deepseek/api-pricing),
[DeepSeek — V4-Flash-Vision-Exp release](https://api-docs.deepseek.com/news/news260821/),
[DeepSeek on X — multimodal API](https://x.com/deepseek_ai/status/2090730039973392531),
[Gemini API pricing (official)](https://ai.google.dev/gemini-api/docs/pricing),
[TokenCost — Gemini 3.5 Flash-Lite price change](https://tokencost.app/blog/gemini-3-5-flash-lite-price-increase),
[pricepertoken — Gemini 2.5 Flash-Lite](https://pricepertoken.com/pricing-page/model/google-gemini-2.5-flash-lite).

The cost estimator (`src/ai/pricing.ts`) uses the **peak** DeepSeek rate and the Gemini rate above, and costs
unknown models at the most expensive known rate (fail safe). Override with `AI_PRICES` (JSON, server-side).

## Order of magnitude (estimate, not a quote)

A typical provider-assisted onboarding turn ≈ 1,000 input + 150 output tokens. At the snapshot rates:
DeepSeek ≈ US$0.0005 (peak), Gemini 3.5 Flash-Lite ≈ US$0.0007. Most turns cost **zero** because the local
interpreter reads them. The limits in ADR-0006 are protection (abuse, loops, bots), not a cost-per-message
promise; decide final values from measured P50/P90/P95 after the beta (`ai_calls`).

## Benchmark (reproducible)

`node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/ai-bench.ts local deepseek gemini`

- Text: `tests/fixtures/ai/text-cases.json` — 30 synthetic Spanish/Peruvian messages (messy multi-fact, bare
  answers, "no sé", corrections, USD, slang, numbers in words, prompt injection, secrets in the text).
- Vision: `tests/fixtures/ai/vision/*.png` — 10 synthetic images (BCP/BBVA/Interbank statements, blurry,
  missing minimum, two currencies, loan schedule, electricity and internet bills, receipt, bank screen).
- Metrics: fact recall, hallucinated facts (precision misses), valid JSON, P50/P90 latency, provider-reported
  tokens and estimated cost. Report: `.e2e/bench/report.json`.

### Results so far

| Candidate | Text recall | Hallucinated facts | Perfect cases | Vision | Cost |
|---|---|---|---|---|---|
| `local` (deterministic, 2026-09-28) | **90%** | 3 | 26/30 | n/a | US$0 |
| DeepSeek | not run — needs `DEEPSEEK_API_KEY` | | | | |
| Gemini | not run — needs `GEMINI_API_KEY` | | | | |

Local misses (the cases a provider must add value on): numbers in words ("tres mil quinientos"), slang
("me quedé misio"), variable income ("a veces 2000 a veces 3000" → must be unknown), and several cards in one
sentence. Selection criterion (§60): accuracy and zero hallucinated amounts first, then JSON reliability,
latency, and cost last.

## What is needed to finish the evaluation (stop point)

The PO must choose and provide, as **server-side environment variables in Vercel** (never in the repo):
- DeepSeek: `DEEPSEEK_API_KEY` (platform.deepseek.com, prepaid balance), and/or
- Gemini: `GEMINI_API_KEY` (Google AI Studio; paid tier recommended so prompts are not used for training).

Then: run the benchmark with both keys, record the table above, pick `AI_PROVIDER` / `AI_TEXT_MODEL` /
`AI_VISION_MODEL` (+ optional `AI_FALLBACK_PROVIDER`), and review each provider's data-retention terms.
