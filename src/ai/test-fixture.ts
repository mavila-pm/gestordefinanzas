import { createHash } from 'node:crypto';
import { AIError, type AIModel, type AIRequest, type AIResult } from './model';
import { VISION_FIXTURES } from './test-fixture-data';

/**
 * TEST SUPPORT, not a provider: canned answers for unit tests and E2E (a real `next start` with AI_FIXTURE=1, where no
 * stub can be injected). Never on a production deployment (config.ts).
 * It exercises the full path (reservation, validation, usage recording) with fixed answers:
 *  - extraction: a few canned phrases the local rules cannot read; otherwise an empty result;
 *  - vision: synthetic images identified by SHA-256 (tests/fixtures/ai/vision); unknown image → nothing read;
 *  - assistant: structured route ("¿cuánto me sobra?" → free; else other + a fixed sentence), or that sentence as text.
 * Token counts are synthetic (chars/4) and labelled as fixture usage.
 */
const CANNED: Array<[RegExp, string]> = [
  [/misio|me quedo sin plata|no me alcanza/i, '{"patches":[{"t":"variable","name":"Gastos básicos","unknownAmount":true}],"bare":null}'],
  [/fixture-fail/i, 'FAIL'],
  [/fixture-garbage/i, 'esto no es json'],
];
const tokens = (s: string) => Math.ceil(s.length / 4);

export function testFixture(): AIModel {
  return {
    name: 'fixture',
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
        const reply = 'Con lo que tengo registrado no puedo responder eso con precisión. Prueba preguntando cuánto tienes libre o qué pagos vienen.';
        const text = JSON.stringify(/cuanto me sobra|cuánto me sobra/i.test(last) ? { intent: 'free' } : { intent: 'other', reply });
        return { text, usage: { input, output: tokens(text), cached: 0, image: 0 }, model: req.model, latencyMs: 5 };
      }
      const canned = CANNED.find(([re]) => re.test(last))?.[1] ?? '{"patches":[],"bare":null}';
      if (canned === 'FAIL') throw new AIError('http', 'fixture failure', true, { input, output: 0, cached: 0, image: 0 });
      return { text: canned, usage: { input, output: tokens(canned), cached: 0, image: 0 }, model: req.model, latencyMs: 5 };
    },
  };
}
