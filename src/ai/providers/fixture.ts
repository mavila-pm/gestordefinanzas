import { createHash } from 'node:crypto';
import { AIProviderError, type AIProvider, type AIRequest, type AIResult } from '../provider';
import { VISION_FIXTURES } from './fixture-data';

/**
 * Deterministic stand-in provider for tests, QA and the benchmark harness (never production, see config.ts).
 * It exercises the full path (reservation, validation, usage recording) with fixed answers:
 *  - extraction: a few canned phrases the local rules cannot read; otherwise an empty result;
 *  - vision: synthetic images identified by SHA-256 (tests/fixtures/ai/vision); unknown image → nothing read;
 *  - assistant: a fixed short sentence.
 * Token counts are synthetic (chars/4) and labelled as fixture usage.
 */
const CANNED: Array<[RegExp, string]> = [
  [/misio|me quedo sin plata|no me alcanza/i, '{"patches":[{"t":"variable","name":"Gastos básicos","unknownAmount":true}],"bare":null}'],
  [/fixture-fail/i, 'FAIL'],
  [/fixture-garbage/i, 'esto no es json'],
];
const tokens = (s: string) => Math.ceil(s.length / 4);

export function fixtureProvider(): AIProvider {
  return {
    name: 'fixture',
    supportsVision: () => true,
    async complete(req: AIRequest): Promise<AIResult> {
      const last = req.messages.at(-1)?.content ?? '';
      const input = tokens(req.system) + req.messages.reduce((s, m) => s + tokens(m.content), 0);
      if (req.operation === 'vision_extract') {
        const img = req.images?.[0];
        const hash = img ? createHash('sha256').update(Buffer.from(img.base64, 'base64')).digest('hex') : '';
        const hit = VISION_FIXTURES[hash];
        const text = hit ? JSON.stringify(hit) : '{"document":"other","confidence":"low","uncertain":[]}';
        return { text, usage: { input, output: tokens(text), cached: 0, image: 258 * (req.images?.length ?? 0) }, model: req.model, latencyMs: 5 };
      }
      if (req.operation === 'assistant_answer') {
        const text = 'Con lo que tengo registrado no puedo responder eso con precisión. Prueba preguntando cuánto tienes libre o qué pagos vienen.';
        return { text, usage: { input, output: tokens(text), cached: 0, image: 0 }, model: req.model, latencyMs: 5 };
      }
      const canned = CANNED.find(([re]) => re.test(last))?.[1] ?? '{"patches":[],"bare":null}';
      if (canned === 'FAIL') throw new AIProviderError('http', 'fixture failure', true, { input, output: 0, cached: 0, image: 0 });
      return { text: canned, usage: { input, output: tokens(canned), cached: 0, image: 0 }, model: req.model, latencyMs: 5 };
    },
  };
}
