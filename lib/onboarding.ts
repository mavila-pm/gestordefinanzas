import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { domainWrites, validPatches } from '../src/ai/apply';
import { isReplay } from './idempotency';
import type { ChatMessage, MessageCard } from '../src/ai/conversation';
import { agendaLine, canStart, compactState, hasFacts, mergePatches, money, nextQuestion, pendingReply, shortDate, shortReply, summarize, unreadNumbers, upcomingFromDraft, yesNoReply, type Changed } from '../src/ai/draft';
import { limaToday } from '../src/engine/planning';
import { checkImage, IMAGE_ERROR_TEXT, imageReadKey, READ_REUSE_MINUTES } from '../src/ai/image';
import { interpret, isSmallTalk } from '../src/ai/interpreter';
import { fold } from '../src/ai/text';
import { EXTRACT_SYSTEM, VISION_SYSTEM } from '../src/ai/prompts';
import { sanitizeUserText } from '../src/ai/sanitize';
import { validateInterpretation, validateVision } from '../src/ai/schema';
import { emptyDraft, type Draft } from '../src/ai/types';
import { proposalFrom, type VisionProposal } from '../src/ai/vision';
import { preferredName } from '../src/domain/profile';
import { infer, STOP_TEXT } from './ai';
import { loadProfile } from './queries';

/**
 * Conversational onboarding turn logic (ADR-0006). The structured draft is the memory; messages are the short
 * visible conversation. Deterministic first: the local interpreter reads most messages at zero cost; a provider
 * is called when nothing could be read OR the reading left numbers unused (partial), and only if one is configured.
 * Either way the output goes through the same validation and merge: the model never writes money by itself. Taps (summary, start, confirm) never call AI.
 */
export interface OnboardingState { status: 'active' | 'completed' | 'skipped'; isDemo: boolean; draft: Draft; applied: Record<string, string[]>; startedAt: string | null }

export async function loadOnboarding(supabase: SupabaseClient): Promise<OnboardingState | null> {
  const { data } = await supabase.from('onboarding_states').select('status,is_demo,facts,applied,started_at').maybeSingle();
  if (!data) return null;
  const facts = (data.facts ?? {}) as Partial<Draft>;
  return { status: data.status, isDemo: data.is_demo, draft: { ...emptyDraft(), ...facts }, applied: (data.applied ?? {}) as Record<string, string[]>, startedAt: data.started_at ?? null };
}

export async function loadMessages(supabase: SupabaseClient, thread: 'onboarding' | 'assistant', limit = 60): Promise<ChatMessage[]> {
  const { data } = await supabase.from('conversation_messages').select('id,role,body,card').eq('thread', thread).order('created_at', { ascending: false }).limit(limit);
  return (data ?? []).reverse().map((m) => {
    const { vision: _proposal, readKey: _key, ...card } = (m.card ?? {}) as MessageCard; // the pending proposal stays server-side
    return { id: m.id, role: m.role, body: m.body, card: m.card ? card : null };
  });
}

async function say(supabase: SupabaseClient, userId: string, thread: 'onboarding' | 'assistant', role: 'user' | 'velsuno', body: string, card: MessageCard | null = null) {
  await supabase.from('conversation_messages').insert({ user_id: userId, thread, role, body: body.slice(0, 2000), card });
}

async function save(supabase: SupabaseClient, userId: string, draft: Draft, extra: Record<string, unknown> = {}) {
  const { error } = await supabase.from('onboarding_states').update({ facts: draft, summary: compactState(draft).slice(0, 1000), ...extra }).eq('user_id', userId);
  if (error) throw new Error('onboarding_save_failed');
}

/** Creates the state (once). Demo-allowlisted users are marked so their reset is exact. Idempotent under races. */
export async function startOnboarding(supabase: SupabaseClient, userId: string): Promise<OnboardingState> {
  const existing = await loadOnboarding(supabase);
  if (existing) return existing;
  const { data: demo } = await supabase.from('demo_access').select('user_id').maybeSingle();
  const { error } = await supabase.from('onboarding_states').insert({ user_id: userId, status: 'active', is_demo: !!demo, facts: emptyDraft() });
  if (!error) return { status: 'active', isDemo: !!demo, draft: emptyDraft(), applied: {}, startedAt: null };
  // 23505: a parallel request created it. Re-read with a different query: identical GETs are memoized within a render.
  if (error.code !== '23505') throw new Error(`onboarding_start_failed: ${error.code}`);
  const { data } = await supabase.from('onboarding_states').select('status,is_demo,facts,applied,started_at').eq('user_id', userId).single();
  return { status: data!.status, isDemo: data!.is_demo, draft: { ...emptyDraft(), ...(data!.facts ?? {}) }, applied: data!.applied ?? {}, startedAt: data!.started_at ?? null };
}

/** The opening is fixed copy, not stored: it is always there and cannot be lost or duplicated (§4). */
export async function onboardingConversation(supabase: SupabaseClient): Promise<ChatMessage[]> {
  const [name, messages] = await Promise.all([loadProfile(supabase).then(preferredName), loadMessages(supabase, 'onboarding')]);
  return [
    { id: 'greet-1', role: 'velsuno', body: `${name ? `Hola, ${name}. ` : 'Hola. '}Vamos a ordenar esto juntos.`, card: null },
    { id: 'greet-2', role: 'velsuno', body: 'Cuéntame de tu dinero como te salga: cuánto recibes y cuándo, qué pagos tienes y si debes algo.',
      card: messages.length ? null : { actions: [{ kind: 'camera', label: 'Mostrar una foto' }] } },
    ...messages,
  ];
}

/**
 * The reply after a turn: a short line about what changed, then the ONE next question. When the fixed payments are
 * complete, the next ones in calendar order (planning engine, Lima date). At the end, what comes until the next
 * income and today's balance — all from the person's facts and the engine, never from a model.
 */
export function followUp(draft: Draft, changed: Changed[], today: string = limaToday(), answered: string | null = null): { body: string; card: MessageCard; draft: Draft } {
  const q = nextQuestion(draft);
  const card: MessageCard = {};
  const facts = changed.filter((c) => c.ref !== 'removed');
  // The card only when several things changed at once (one item is already said in the sentence).
  if (facts.length >= 2) { card.title = 'Entendí esto'; card.rows = facts.map(({ label, value }) => ({ label, value })); }
  let lead = shortReply(draft, changed, answered);
  const paymentsReady = draft.obligations.length >= 2 && draft.obligations.every((o) => o.day !== null || draft.asked.includes(`obligation:${o.id}:day`));
  if (changed.some((c) => c.ref?.startsWith('obligation:')) && paymentsReady && !q?.key.startsWith('obligation:')) {
    const ids = new Set(draft.obligations.map((o) => o.name));
    const agenda = upcomingFromDraft(draft, today).items.filter((x) => ids.has(x.name));
    if (agenda.length >= 2) lead = `${lead} Entonces lo próximo sería: ${agendaLine(agenda)}.`.trim();
  }
  if (q) {
    draft.asked.push(q.key);
    draft.pending = q.key;
    card.question = q.text;
    card.replies = q.replies.filter((r) => r !== 'Tomar foto');
    card.actions = [...(q.replies.includes('Tomar foto') ? [{ kind: 'camera' as const, label: 'Tomar foto' }] : []), ...(canStart(draft) ? [{ kind: 'summary' as const, label: 'Ver mi resumen' }] : [])];
    return { body: lead ? `${lead} ${q.text}` : q.text, card, draft };
  }
  const up = upcomingFromDraft(draft, today);
  const lines = up.items.slice(0, 6).map((x) => `• ${x.name} · ${shortDate(x.date)} · ${x.amountMinor === null ? 'monto por confirmar' : money(x.amountMinor, x.currency)}`);
  const balance = draft.balance?.amountMinor != null ? `Y hoy tienes ${money(draft.balance.amountMinor, draft.balance.currency)} disponibles.` : '';
  card.summary = summarize(draft);
  card.actions = [{ kind: 'correct', label: 'Corregir' }, { kind: 'start', label: 'Empezar' }];
  const body = ['Ya lo tengo.', lines.length ? `${up.until ? 'Hasta tu próximo ingreso vienen:' : 'Lo próximo:'}\n${lines.join('\n')}` : '', balance].filter(Boolean).join(lines.length ? '\n\n' : ' ');
  return { body, card, draft };
}

export async function onboardingText(supabase: SupabaseClient, userId: string, raw: string): Promise<void> {
  const state = await loadOnboarding(supabase) ?? await startOnboarding(supabase, userId);
  const { text } = sanitizeUserText(raw);
  if (!text) return;
  await say(supabase, userId, 'onboarding', 'user', text);
  // Replies only the pending question can place ("sí, el 15", a loan's entity or "36, llevo 10").
  const placed = pendingReply(state.draft, text);
  if (placed) {
    const next = followUp(placed.draft, placed.changed, limaToday(), state.draft.pending);
    await save(supabase, userId, next.draft);
    await say(supabase, userId, 'onboarding', 'velsuno', next.body, next.card);
    return;
  }
  // "Sí" / "No" answer the pending question; they never become an amount or a movement.
  const yn = yesNoReply(state.draft, text);
  if (yn && (yn.patches.length || yn.reask)) {
    if (yn.reask) { await say(supabase, userId, 'onboarding', 'velsuno', yn.reask, { actions: canStart(state.draft) ? [{ kind: 'summary', label: 'Ver mi resumen' }] : [] }); return; }
    const merged = mergePatches(state.draft, yn.patches, null);
    const next = followUp(merged.draft, merged.changed);
    await save(supabase, userId, next.draft);
    await say(supabase, userId, 'onboarding', 'velsuno', next.body, next.card);
    return;
  }
  if (isSmallTalk(text) && !state.draft.pending) { await say(supabase, userId, 'onboarding', 'velsuno', '¿Algo más que quieras contarme? Si no, puedes ver tu resumen.', { actions: hasFacts(state.draft) ? [{ kind: 'summary', label: 'Ver mi resumen' }] : [] }); return; }

  let read = interpret(text);
  const partial = unreadNumbers(fold(text), read) > 0;
  if ((!read.patches.length && !read.bare) || partial) {
    const pendingQ = state.draft.pending ? `Pregunta pendiente: ${state.draft.pending}` : 'Sin pregunta pendiente';
    const r = await infer(supabase, { operation: 'onboarding_extract', system: EXTRACT_SYSTEM, json: true,
      messages: [{ role: 'user', content: `${pendingQ}\nDatos ya registrados:\n${compactState(state.draft) || '(ninguno)'}\n\nMensaje:\n${text}` }] },
    (t) => validateInterpretation(t) !== null);
    if (r.ok) {
      // A provider answer that read nothing never replaces a partial deterministic reading.
      const ai = validateInterpretation(r.text)!;
      if (ai.patches.length || ai.bare || !partial) read = ai;
    }
    else if (partial) { /* provider off, failed or out of quota: keep the deterministic reading (never lose a turn) */ }
    else if (r.reason !== 'unavailable' && r.reason !== 'failed') {
      await save(supabase, userId, state.draft);
      await say(supabase, userId, 'onboarding', 'velsuno', `${r.reason === 'ai_quota' ? 'Guardé todo lo que me contaste. Podemos seguir después.' : STOP_TEXT[r.reason]}`,
        { stop: true, actions: hasFacts(state.draft) ? [{ kind: 'summary', label: 'Ver mi resumen' }] : [] });
      return;
    }
  }
  if (!read.patches.length && !read.bare) {
    await say(supabase, userId, 'onboarding', 'velsuno', 'No te entendí del todo. Prueba con montos y días, por ejemplo: "me pagan 3,000 el 30" o "pago alquiler 1,200 el 1".',
      { actions: hasFacts(state.draft) ? [{ kind: 'summary', label: 'Ver mi resumen' }] : [] });
    return;
  }
  const merged = mergePatches(state.draft, read.patches, read.bare);
  const next = followUp(merged.draft, merged.changed, limaToday(), state.draft.pending);
  await save(supabase, userId, next.draft);
  await say(supabase, userId, 'onboarding', 'velsuno', next.body, next.card);
}

/** "Después" / "No sé" chips: the pending question stays unknown (never 0) and we move on. */
export async function onboardingSkip(supabase: SupabaseClient, userId: string, label: string): Promise<void> {
  await onboardingText(supabase, userId, label === 'No tengo más' ? 'no tengo más pagos' : label === 'Quincenal' ? 'quincenal' : 'no sé');
}

export async function onboardingSummary(supabase: SupabaseClient, userId: string): Promise<void> {
  const state = await loadOnboarding(supabase);
  if (!state) return;
  await say(supabase, userId, 'onboarding', 'velsuno', 'Esto es lo que tengo:', { summary: summarize(state.draft), actions: [{ kind: 'correct', label: 'Corregir' }, { kind: 'start', label: 'Empezar' }] });
}

export type ImageRead = { ok: true; proposal: VisionProposal; readKey: string; reused?: boolean } | { ok: false; text: string; stop?: boolean } | { ok: false; empty: true };

/**
 * Camera read (§12-§18), shared by onboarding and "Preguntar": validate → temporary processing → structured facts.
 * The image is never stored (only in this request's memory); nothing is applied here.
 */
export async function readImages(supabase: SupabaseClient, files: File[], context: string, echo: (body: string) => Promise<void>,
  thread: 'onboarding' | 'assistant' = 'onboarding'): Promise<ImageRead> {
  const checked: Uint8Array[] = [];
  const images = [];
  for (const f of files.slice(0, 4)) {
    const check = checkImage(new Uint8Array(await f.arrayBuffer()));
    if (!check.ok) return { ok: false, text: IMAGE_ERROR_TEXT[check.error] };
    checked.push(check.bytes);
    images.push({ mime: check.mime, base64: Buffer.from(check.bytes).toString('base64') });
  }
  if (!images.length) return { ok: false, empty: true };
  await echo(images.length === 1 ? 'Foto enviada' : `${images.length} fotos enviadas`);
  // Same photos again soon (double tap, "Reintentar" after a slow answer): reuse the first read — no second charge.
  const readKey = await imageReadKey(checked);
  checked.length = 0;
  const since = new Date(Date.now() - READ_REUSE_MINUTES * 60_000).toISOString();
  // Only while that proposal is still the latest Velsuno message (unanswered): once confirmed or rejected, re-read.
  const { data: prior } = await supabase.from('conversation_messages').select('card').eq('thread', thread).eq('role', 'velsuno')
    .gte('created_at', since).order('created_at', { ascending: false }).limit(1).maybeSingle();
  const reused = (prior?.card as MessageCard | null)?.readKey === readKey ? prior!.card as MessageCard : null;
  // Conversation rows are client-insertable (own rows): the stored proposal is re-validated like any untrusted input.
  const reusedPatches = validPatches(reused?.vision);
  if (reusedPatches.length && typeof reused?.title === 'string' && Array.isArray(reused.rows)) {
    images.length = 0;
    const rows = reused.rows.slice(0, 8).filter((r) => r && typeof r === 'object').map((r) => ({ label: String(r.label).slice(0, 40), value: String(r.value).slice(0, 60), doubtful: !!r.doubtful }));
    return { ok: true, readKey, reused: true, proposal: { title: reused.title.slice(0, 80), rows, patches: reusedPatches } };
  }
  const r = await infer(supabase, { operation: 'vision_extract', system: VISION_SYSTEM, json: true, images,
    messages: [{ role: 'user', content: `Extrae los datos. Contexto: ${context}` }] }, (t) => validateVision(t) !== null);
  images.length = 0; // discard the image data as soon as the read is done
  if (!r.ok) return { ok: false, text: STOP_TEXT[r.reason], stop: r.reason !== 'failed' };
  const proposal = proposalFrom(validateVision(r.text)!);
  return proposal ? { ok: true, readKey, proposal } : { ok: false, text: 'No encontré datos claros en esa imagen. Puedes escribirlos o probar con otra captura.' };
}

export async function onboardingImages(supabase: SupabaseClient, userId: string, files: File[]): Promise<void> {
  const state = await loadOnboarding(supabase) ?? await startOnboarding(supabase, userId);
  const read = await readImages(supabase, files, state.draft.pending ?? 'configuración inicial', (b) => say(supabase, userId, 'onboarding', 'user', b));
  if (!read.ok) { if ('text' in read) await say(supabase, userId, 'onboarding', 'velsuno', read.text, read.stop ? { stop: true } : null); return; }
  const { proposal } = read;
  state.draft.vision = proposal.patches;
  await save(supabase, userId, state.draft);
  const doubtful = proposal.rows.some((row) => row.doubtful);
  await say(supabase, userId, 'onboarding', 'velsuno', doubtful ? 'Encontré esto. Confirma los datos marcados:' : 'Encontré esto:',
    { title: proposal.title, rows: proposal.rows, vision: proposal.patches, readKey: read.readKey, actions: [{ kind: 'vision_confirm', label: 'Confirmar' }, { kind: 'vision_discard', label: 'Corregir' }] });
}

export async function onboardingVision(supabase: SupabaseClient, userId: string, confirm: boolean): Promise<void> {
  const state = await loadOnboarding(supabase);
  if (!state?.draft.vision) return;
  if (!confirm) {
    state.draft.vision = null;
    await save(supabase, userId, state.draft);
    await say(supabase, userId, 'onboarding', 'user', 'Corregir');
    await say(supabase, userId, 'onboarding', 'velsuno', 'Listo, no guardé nada de la foto. Escríbeme el dato correcto.');
    return;
  }
  const patches = state.draft.vision;
  state.draft.vision = null;
  await say(supabase, userId, 'onboarding', 'user', 'Confirmar');
  const merged = mergePatches(state.draft, patches, null);
  const next = followUp(merged.draft, merged.changed);
  await save(supabase, userId, next.draft);
  await say(supabase, userId, 'onboarding', 'velsuno', next.body, next.card);
}

/** "Empezar": writes the draft into the product tables (RLS, own rows) and remembers exactly what was created. */
export async function onboardingFinish(supabase: SupabaseClient, userId: string): Promise<{ ok: boolean }> {
  const state = await loadOnboarding(supabase);
  if (!state) return { ok: false };
  if (state.status === 'completed') return { ok: true };
  const w = domainWrites(state.draft, userId);
  const attempt = state.startedAt ? String(Date.parse(state.startedAt)) : '0';
  const applied: Record<string, string[]> = {};
  let replayed = false;
  const insert = async (table: string, rows: Array<Record<string, unknown>>) => {
    if (!rows.length) return true;
    // Deterministic per attempt: a double "Empezar" (two tabs) cannot create the onboarding rows twice (ADR-0012).
    // The attempt nonce (started_at) keeps a leftover row from an earlier (reset) onboarding from masking this one.
    const refd = ['fixed_expenses', 'debts', 'expected_incomes', 'accounts'].includes(table) ? rows.map((r, n) => ({ ...r, client_ref: `onb:${attempt}:${table}:${n}` })) : rows;
    const { data, error } = await supabase.from(table).insert(refd).select('id');
    if (isReplay(error)) { replayed = true; return false; }
    if (error) return false;
    applied[table] = (data ?? []).map((r) => r.id as string);
    return true;
  };
  const ok = await insert('expected_incomes', w.incomes) && await insert('fixed_expenses', w.obligations) && await insert('debts', w.debts)
    && await insert('accounts', w.accounts) && await insert('cards', w.cards) && await insert('balance_snapshots', w.balance ? [w.balance] : []);
  if (ok && w.settings) {
    const { data: cur } = await supabase.from('planning_settings').select('essentials_monthly_minor').eq('currency', 'PEN').maybeSingle();
    if (!cur || cur.essentials_monthly_minor === null) await supabase.from('planning_settings').upsert(w.settings);
  }
  if (!ok && replayed) {
    // A parallel "Empezar" already wrote these rows: undo only what THIS attempt created. Success only once the
    // other request really completed; otherwise report the failure (never a silent success).
    for (const [table, ids] of Object.entries(applied)) await supabase.from(table).delete().in('id', ids);
    for (let i = 0; i < 10; i++) {
      const s = await loadOnboarding(supabase);
      if (s?.status === 'completed') return { ok: true };
      await new Promise((r) => setTimeout(r, 300));
    }
    return { ok: false };
  }
  if (!ok) {
    // Partial write: undo what this attempt created so a retry does not duplicate anything.
    for (const [table, ids] of Object.entries(applied)) await supabase.from(table).delete().in('id', ids);
    return { ok: false };
  }
  const { error } = await supabase.from('onboarding_states').update({ status: 'completed', completed_at: new Date().toISOString(), applied }).eq('user_id', userId);
  return { ok: !error };
}

/** "Ahora no": keep every fact, leave the conversation for later (resumable from Más). */
export async function onboardingLeave(supabase: SupabaseClient, userId: string) {
  await supabase.from('onboarding_states').update({ status: 'skipped' }).eq('user_id', userId).eq('status', 'active');
}
export async function onboardingResume(supabase: SupabaseClient, userId: string) {
  const s = await loadOnboarding(supabase);
  if (!s) { await startOnboarding(supabase, userId); return; }
  if (s.status === 'skipped') await supabase.from('onboarding_states').update({ status: 'active' }).eq('user_id', userId);
}

/**
 * Demo only (§76): restore the first-time experience. Removes exactly the rows this onboarding created (ids
 * recorded at "Empezar"), the onboarding conversation and draft, and gives back the one-time allowance.
 * Never touches anything else in the account.
 */
export async function resetDemoOnboarding(supabase: SupabaseClient, userId: string): Promise<{ ok: boolean }> {
  const { data: demo } = await supabase.from('demo_access').select('user_id').maybeSingle();
  if (!demo) return { ok: false };
  const s = await loadOnboarding(supabase);
  const snapshots = s?.applied.balance_snapshots ?? [];
  if (snapshots.length) await supabase.rpc('delete_demo_balance_snapshots', { p_ids: snapshots });
  for (const table of ['cards', 'accounts', 'debts', 'fixed_expenses', 'expected_incomes'] as const) {
    const ids = s?.applied[table] ?? [];
    if (ids.length) await supabase.from(table).delete().in('id', ids);
  }
  await supabase.from('conversation_messages').delete().eq('thread', 'onboarding');
  await supabase.rpc('reset_demo_ai_onboarding');
  await supabase.from('onboarding_states').update({ status: 'active', is_demo: true, facts: emptyDraft(), applied: {}, summary: null, completed_at: null, started_at: new Date().toISOString() }).eq('user_id', userId);
  return { ok: true };
}
