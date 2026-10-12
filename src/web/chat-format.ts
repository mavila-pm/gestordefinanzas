/**
 * How a Vels message is laid out on screen (presentation only; the stored text is unchanged). A message that
 * already has line breaks (lists, explanations) keeps them. Otherwise:
 *  - a question after a real statement goes on its own line ("Listo, S/ 1,200 de alquiler.\n¿Qué día lo pagas?");
 *    a one-word lead ("Perfecto. ¿…?", "Claro. ¿…?") stays on the same line;
 *  - a long message with three or more sentences shows one sentence per line (no dense blocks).
 */
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export function formatVels(text: string): string {
  const t = text.trim();
  if (!t || t.includes('\n')) return t;
  // Sentence boundaries: ". " / "! " / ": " before an uppercase letter, "¿" or a quote (never "S/ 1,200.50" or "aprox. hasta").
  const parts = t.split(/(?<=[.!])\s+(?=[A-ZÁÉÍÓÚÑ¿«"])/);
  if (parts.length === 1) return t;
  if (t.length > 160 && parts.length >= 3) return parts.join('\n');
  const out: string[] = [];
  for (const p of parts) {
    const prev = out.at(-1);
    if (prev !== undefined && p.startsWith('¿') && words(prev) >= 3) out.push(p);
    else if (prev !== undefined) out[out.length - 1] = `${prev} ${p}`;
    else out.push(p);
  }
  return out.join('\n');
}
