/** Pure validation for the AI test endpoint (POST /api/ai/chat), unit-tested. Only `message` is accepted. */

export const AI_CHAT_MAX_CHARS = 1000;
export const AI_CHAT_MAX_BYTES = 8 * 1024;

export type AIChatInput = { ok: true; message: string } | { ok: false; error: string };

export function parseAIChatInput(body: unknown): AIChatInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Envía un JSON con el campo "message".' };
  const keys = Object.keys(body);
  // No model, temperature, system prompt or tokens from the browser: those are server decisions.
  if (keys.some((k) => k !== 'message')) return { ok: false, error: 'Solo se acepta el campo "message".' };
  const raw = (body as { message?: unknown }).message;
  if (typeof raw !== 'string') return { ok: false, error: 'Escribe un mensaje.' };
  // Control characters out (keep line breaks and tabs); length counted after trimming.
  const message = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (!message) return { ok: false, error: 'Escribe un mensaje.' };
  if (message.length > AI_CHAT_MAX_CHARS) return { ok: false, error: `Usa como máximo ${AI_CHAT_MAX_CHARS} caracteres.` };
  return { ok: true, message };
}

/** The endpoint and its test page exist off production unless AI_TEST_ENDPOINT=1 is set there on purpose. */
export const aiTestEnabled = (env: Record<string, string | undefined> = process.env) =>
  env.VERCEL_ENV !== 'production' || env.AI_TEST_ENDPOINT === '1';
