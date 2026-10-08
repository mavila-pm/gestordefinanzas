/**
 * Reproducible AI benchmark (ADR-0006, adenda §27, §59-§60). Scores extraction on SYNTHETIC cases:
 *   text:   tests/fixtures/ai/text-cases.json   (30 Spanish/Peruvian onboarding messages)
 *   vision: tests/fixtures/ai/vision/*.png       (10 synthetic statements, bills, receipts, screens)
 * Candidates: `local` (deterministic interpreter, zero cost) and any configured provider (AI_PROVIDER + key).
 * Metrics: field precision/recall (hallucinated facts = precision misses), valid JSON rate, latency, provider-
 * reported tokens and estimated cost. Nothing is persisted except the report under .e2e/bench/.
 * Run: node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/ai-bench.ts [local|gemini|fixture ...]
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { aiConfig, providerFor, type ProviderName } from '../src/ai/config.ts';
import { mergePatches } from '../src/ai/draft.ts';
import { checkImage } from '../src/ai/image.ts';
import { interpret } from '../src/ai/interpreter.ts';
import { estimateCostMicroUsd, ratesFrom } from '../src/ai/pricing.ts';
import { EXTRACT_SYSTEM, PROMPT_VERSION, VISION_SYSTEM } from '../src/ai/prompts.ts';
import { sanitizeUserText } from '../src/ai/sanitize.ts';
import { validateInterpretation, validateVision } from '../src/ai/schema.ts';
import { emptyDraft, type Draft, type Interpretation } from '../src/ai/types.ts';

interface TextCase { id: string; message: string; pending?: string; setup?: string; facts: string[] }
const lower = (s: string) => s.toLowerCase();

/** Draft → flat fact strings, the provider-independent scoring unit. */
export function flatten(d: Draft): string[] {
  const out: string[] = [];
  const amt = (v: number | null) => (v === null ? 'unknown' : String(v));
  for (const i of d.incomes) {
    out.push(`income.amount=${amt(i.amountMinor)}`);
    if (i.day !== null) out.push(`income.day=${i.day}`);
    if (i.frequency === 'semimonthly') out.push('income.frequency=semimonthly');
    if (i.currency === 'USD') out.push('income.currency=USD');
  }
  for (const o of d.obligations) {
    const key = ['services', 'subscription', 'other'].includes(o.kind) && !/^(gimnasio)$/i.test(o.name) ? lower(o.name) : o.kind;
    out.push(`obligation:${key}.amount=${amt(o.amountMinor)}`);
    if (o.day !== null) out.push(`obligation:${key}.day=${o.day}`);
  }
  for (const x of d.debts) {
    out.push(`debt:${x.kind}.balance=${amt(x.balanceMinor)}`);
    if (x.minimumMinor !== null) out.push(`debt:${x.kind}.minimum=${x.minimumMinor}`);
    if (x.dueDay !== null) out.push(`debt:${x.kind}.dueDay=${x.dueDay}`);
  }
  for (const a of d.accounts) out.push(`account:${a.institution}:${a.kind}`);
  for (const v of d.variable) out.push(`variable:${lower(v.name)}.amount=${amt(v.amountMinor)}`);
  if (d.balance) out.push(`balance=${amt(d.balance.amountMinor)}`);
  for (const g of d.done) out.push(`done=${g}`);
  return out;
}

function draftFor(c: TextCase, read: Interpretation): Draft {
  let d = emptyDraft();
  if (c.setup) { const s = interpret(c.setup); d = mergePatches(d, s.patches, s.bare).draft; }
  if (c.pending) {
    const key = c.pending.startsWith('debt:') ? `debt:${d.debts[0]?.id}:balance` : c.pending;
    d = { ...d, pending: key };
  }
  return mergePatches(d, read.patches, read.bare).draft;
}

function score(expected: string[], got: string[]) {
  const exp = [...expected];
  let hit = 0;
  for (const g of got) { const i = exp.indexOf(g); if (i >= 0) { hit++; exp.splice(i, 1); } }
  // Only facts the case is about count as hallucinations (setup facts are excluded by construction).
  return { hit, expected: expected.length, extra: got.length - hit };
}

const which = (process.argv.slice(2).length ? process.argv.slice(2) : ['local']) as Array<'local' | ProviderName>;
const cases = (JSON.parse(readFileSync('tests/fixtures/ai/text-cases.json', 'utf8')) as { cases: TextCase[] }).cases;
const visionExpected = JSON.parse(readFileSync('tests/fixtures/ai/vision/expected.json', 'utf8')) as Record<string, Record<string, unknown>>;
const rates = ratesFrom();
const report: Record<string, unknown> = { date: new Date().toISOString(), promptVersion: PROMPT_VERSION, candidates: {} };
mkdirSync('.e2e/bench', { recursive: true });

for (const cand of which) {
  let hit = 0, total = 0, extra = 0, valid = 0, calls = 0, input = 0, output = 0, cost = 0;
  const latencies: number[] = [];
  const perCase: Array<Record<string, unknown>> = [];
  const provider = cand === 'local' ? null : providerFor(cand);
  if (cand !== 'local' && !provider) { console.log(`${cand}: not configured (needs its API key) — skipped`); continue; }
  const cfg = aiConfig({ ...process.env, AI_PROVIDER: cand === 'local' ? 'none' : cand });
  for (const c of cases) {
    const setupFacts = c.setup ? flatten(draftFor({ ...c, message: '' }, { patches: [], bare: null })) : [];
    const t0 = Date.now();
    let read: Interpretation | null;
    if (!provider) read = interpret(sanitizeUserText(c.message).text);
    else {
      try {
        const r = await provider.complete({ operation: 'onboarding_extract', model: cfg.textModel, system: EXTRACT_SYSTEM, json: true, maxOutputTokens: cfg.maxOutput.onboarding_extract,
          reasoning: cfg.reasoning, timeoutMs: cfg.timeoutMs, messages: [{ role: 'user', content: `${c.pending ? `Pregunta pendiente: ${c.pending}` : 'Sin pregunta pendiente'}\n\nMensaje:\n${sanitizeUserText(c.message).text}` }] });
        calls++; input += r.usage.input; output += r.usage.output; cost += estimateCostMicroUsd(r.model, r.usage, rates);
        read = validateInterpretation(r.text);
      } catch { read = null; }
    }
    latencies.push(Date.now() - t0);
    if (read) valid++;
    const got = read ? flatten(draftFor(c, read)).filter((f) => !setupFacts.includes(f) || c.facts.includes(f)) : [];
    const s = score(c.facts, got);
    hit += s.hit; total += s.expected; extra += s.extra;
    perCase.push({ id: c.id, ok: s.hit === s.expected && s.extra === 0, missed: c.facts.filter((f) => !got.includes(f)), extra: got.filter((f) => !c.facts.includes(f)) });
  }

  // Vision (providers only).
  let vHit = 0, vTotal = 0, vValid = 0;
  const vision: Array<Record<string, unknown>> = [];
  if (provider?.supportsVision(cfg.visionModel)) {
    for (const file of readdirSync('tests/fixtures/ai/vision').filter((f) => f.endsWith('.png'))) {
      const id = file.replace('.png', '');
      const exp = visionExpected[id]!;
      const img = checkImage(new Uint8Array(readFileSync(`tests/fixtures/ai/vision/${file}`)));
      if (!img.ok) continue;
      const t0 = Date.now();
      try {
        const r = await provider.complete({ operation: 'vision_extract', model: cfg.visionModel, system: VISION_SYSTEM, json: true, maxOutputTokens: cfg.maxOutput.vision_extract,
          reasoning: cfg.reasoning, timeoutMs: cfg.timeoutMs, images: [{ mime: img.mime, base64: Buffer.from(img.bytes).toString('base64') }], messages: [{ role: 'user', content: 'Extrae los datos.' }] });
        calls++; input += r.usage.input + r.usage.image; output += r.usage.output; cost += estimateCostMicroUsd(r.model, r.usage, rates);
        latencies.push(Date.now() - t0);
        const v = validateVision(r.text);
        if (v) vValid++;
        const fields: Array<[string, unknown, unknown]> = [
          ['balance', exp.balance, v?.balanceMinor != null ? (v.balanceMinor / 100).toFixed(2) : null], ['payment_minimum', exp.payment_minimum, v?.paymentMinimumMinor != null ? (v.paymentMinimumMinor / 100).toFixed(2) : null],
          ['amount', exp.amount, v?.amountMinor != null ? (v.amountMinor / 100).toFixed(2) : null], ['due_date', exp.due_date, v?.dueDate ?? null], ['currency', exp.currency, v?.currency ?? null], ['last4', exp.last4, v?.last4 ?? null],
        ];
        const relevant = fields.filter(([, e]) => e !== undefined);
        const ok = relevant.filter(([, e, g]) => (e ?? null) === g).length;
        vHit += ok; vTotal += relevant.length;
        vision.push({ id, ok: ok === relevant.length, wrong: relevant.filter(([, e, g]) => (e ?? null) !== g).map(([k, e, g]) => `${k}: expected ${e} got ${g}`) });
      } catch (e) { vision.push({ id, error: (e as Error).message }); vTotal += 1; }
    }
  }
  latencies.sort((a, b) => a - b);
  const summary = {
    textRecall: total ? hit / total : 0, textHallucinatedFacts: extra, validJson: valid / cases.length, casesPerfect: perCase.filter((c) => c.ok).length,
    visionFieldAccuracy: vTotal ? vHit / vTotal : null, visionValidJson: vision.length ? vValid / vision.length : null,
    latencyP50ms: latencies[Math.floor(latencies.length / 2)] ?? 0, latencyP90ms: latencies[Math.floor(latencies.length * 0.9)] ?? 0,
    calls, inputTokens: input, outputTokens: output, estCostUsd: cost / 1_000_000,
  };
  (report.candidates as Record<string, unknown>)[cand] = { summary, text: perCase, vision };
  console.log(`${cand}: text recall ${(summary.textRecall * 100).toFixed(0)}% · hallucinated ${extra} · perfect ${summary.casesPerfect}/${cases.length} · valid ${(summary.validJson * 100).toFixed(0)}%`
    + (summary.visionFieldAccuracy !== null ? ` · vision ${(summary.visionFieldAccuracy * 100).toFixed(0)}%` : '') + ` · p50 ${summary.latencyP50ms}ms · $${summary.estCostUsd.toFixed(5)}`);
  for (const c of perCase.filter((x) => !x.ok)) console.log(`  ${c.id} missed=${JSON.stringify(c.missed)} extra=${JSON.stringify(c.extra)}`);
}
writeFileSync('.e2e/bench/report.json', JSON.stringify(report, null, 2));
