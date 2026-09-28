import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { domainWrites } from '../src/ai/apply';
import type { ChatMessage, MessageCard } from '../src/ai/conversation';
import { canStart, compactState, hasFacts, mergePatches, nextQuestion, summarize, type Changed } from '../src/ai/draft';
import { checkImage, IMAGE_ERROR_TEXT } from '../src/ai/image';
import { interpret, isSmallTalk } from '../src/ai/interpreter';
import { EXTRACT_SYSTEM, VISION_SYSTEM } from '../src/ai/prompts';
import { sanitizeUserText } from '../src/ai/sanitize';
import { validateInterpretation, validateVision } from '../src/ai/schema';
import { emptyDraft, type Draft } from '../src/ai/types';
import { proposalFrom } from '../src/ai/vision';
import { preferredName } from '../src/domain/profile';
import { infer, STOP_TEXT } from './ai';
import { loadProfile } from './queries';

/**
 * Conversational onboarding turn logic (ADR-0006). The structured draft is the memory; messages are the short
 * visible conversation. Deterministic first: the local interpreter reads most messages at zero cost; a provider
 * is called only when nothing could be read and one is configured. Taps (summary, start, confirm) never call AI.
 */
export interface OnboardingState { status: 'active' | 'completed' | 'skipped'; isDemo: boolean; draft: Draft; applied: Record<string, string[]> }

export async function loadOnboarding(supabase: SupabaseClient): Promise<OnboardingState | null> {
  const { data } = await supabase.from('onboarding_states').select('status,is_demo,facts,applied').maybeSingle();
  if (!data) return null;
  const facts = (data.facts ?? {}) as Partial<Draft>;
  return { status: data.status, isDemo: data.is_demo, draft: { ...emptyDraft(), ...facts }, applied: (data.applied ?? {}) as Record<string, string[]> };
}

export async function loadMessages(supabase: SupabaseClient, thread: 'onboarding' | 'assistant', limit = 60): Promise<ChatMessage[]> {
  const { data } = await supabase.from('conversation_messages').select('id,role,body,card').eq('thread', thread).order('created_at', { ascending: false }).limit(limit);
  return (data ?? []).reverse().map((m) => ({ id: m.id, role: m.role, body: m.body, card: m.card as MessageCard | null }));
}

async function say(supabase: SupabaseClient, userId: string, thread: 'onboarding' | 'assistant', role: 'user' | 'velsuno', body: string, card: MessageCard | null = null) {
  await supabase.from('conversation_messages').insert({ user_id: userId, thread, role, body: body.slice(0, 2000), card });
}

async function save(supabase: SupabaseClient, userId: string, draft: Draft, extra: Record<string, unknown> = {}) {
  const { error } = await supabase.from('onboarding_states').update({ facts: draft, summary: compactState(draft).slice(0, 1000), ...extra }).eq('user_id', userId);
  if (error) throw new Error('onboarding_save_failed');
}

/** Creates the state (once) with the greeting. Demo-allowlisted users are marked so their reset is exact. */
export async function startOnboarding(supabase: SupabaseClient, userId: string): Promise<OnboardingState> {
  const existing = await loadOnboarding(supabase);
  if (existing) return existing;
  const { data: demo } = await supabase.from('demo_access').select('user_id').maybeSingle();
  await supabase.from('onboarding_states').insert({ user_id: userId, status: 'active', is_demo: !!demo, facts: emptyDraft() });
  const name = preferredName(await loadProfile(supabase));
  await say(supabase, userId, 'onboarding', 'velsuno', `${name ? `Hola, ${name}. ` : 'Hola. '}Vamos a ordenar esto juntos.`);
  await say(supabase, userId, 'onboarding', 'velsuno', 'Cuéntame de tu dinero como te salga: cuánto recibes y cuándo, qué pagos tienes y si debes algo.',
    { replies: [], actions: [{ kind: 'camera', label: 'Mostrar una foto' }] });
  return (await loadOnboarding(supabase))!;
}

function followUp(draft: Draft, changed: Changed[]): { body: string; card: MessageCard; draft: Draft } {
  const q = nextQuestion(draft);
  const card: MessageCard = {};
  if (changed.length) { card.title = 'Entendí esto'; card.rows = changed; }
  if (q) {
    draft.asked.push(q.key);
    draft.pending = q.key;
    card.question = q.text;
    card.replies = q.replies.filter((r) => r !== 'Tomar foto');
    card.actions = [...(q.replies.includes('Tomar foto') ? [{ kind: 'camera' as const, label: 'Tomar foto' }] : []), ...(canStart(draft) ? [{ kind: 'summary' as const, label: 'Ver mi resumen' }] : [])];
    return { body: changed.length ? q.text : `Perfecto. ${q.text}`, card, draft };
  }
  card.summary = summarize(draft);
  card.actions = [{ kind: 'correct', label: 'Corregir' }, { kind: 'start', label: 'Empezar' }];
  return { body: 'Con esto ya podemos empezar. Esto es lo que tengo:', card, draft };
}

export async function onboardingText(supabase: SupabaseClient, userId: string, raw: string): Promise<void> {
  const state = await loadOnboarding(supabase) ?? await startOnboarding(supabase, userId);
  const { text } = sanitizeUserText(raw);
  if (!text) return;
  await say(supabase, userId, 'onboarding', 'user', text);
  if (isSmallTalk(text) && !state.draft.pending) { await say(supabase, userId, 'onboarding', 'velsuno', '¿Algo más que quieras contarme? Si no, puedes ver tu resumen.', { actions: hasFacts(state.draft) ? [{ kind: 'summary', label: 'Ver mi resumen' }] : [] }); return; }

  let read = interpret(text);
  if (!read.patches.length && !read.bare) {
    const pendingQ = state.draft.pending ? `Pregunta pendiente: ${state.draft.pending}` : 'Sin pregunta pendiente';
    const r = await infer(supabase, { operation: 'onboarding_extract', system: EXTRACT_SYSTEM, json: true,
      messages: [{ role: 'user', content: `${pendingQ}\nDatos ya registrados:\n${compactState(state.draft) || '(ninguno)'}\n\nMensaje:\n${text}` }] },
    (t) => validateInterpretation(t) !== null);
    if (r.ok) read = validateInterpretation(r.text)!;
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
  const next = followUp(merged.draft, merged.changed);
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

/** Camera read (§12-§18): validate → temporary processing → structured facts → confirmation. The image is never stored. */
export async function onboardingImages(supabase: SupabaseClient, userId: string, files: File[]): Promise<void> {
  const state = await loadOnboarding(supabase) ?? await startOnboarding(supabase, userId);
  const images = [];
  for (const f of files.slice(0, 4)) {
    const check = checkImage(new Uint8Array(await f.arrayBuffer()));
    if (!check.ok) { await say(supabase, userId, 'onboarding', 'velsuno', IMAGE_ERROR_TEXT[check.error]); return; }
    images.push({ mime: check.mime, base64: Buffer.from(check.bytes).toString('base64') });
  }
  if (!images.length) return;
  await say(supabase, userId, 'onboarding', 'user', images.length === 1 ? 'Foto enviada' : `${images.length} fotos enviadas`);
  const r = await infer(supabase, { operation: 'vision_extract', system: VISION_SYSTEM, json: true, images,
    messages: [{ role: 'user', content: `Extrae los datos. Contexto: ${state.draft.pending ?? 'configuración inicial'}` }] }, (t) => validateVision(t) !== null);
  images.length = 0; // discard the image data as soon as the read is done
  if (!r.ok) { await say(supabase, userId, 'onboarding', 'velsuno', STOP_TEXT[r.reason], { stop: r.reason !== 'failed' }); return; }
  const proposal = proposalFrom(validateVision(r.text)!);
  if (!proposal) { await say(supabase, userId, 'onboarding', 'velsuno', 'No encontré datos claros en esa imagen. Puedes escribirlos o probar con otra captura.'); return; }
  state.draft.vision = proposal.patches;
  await save(supabase, userId, state.draft);
  const doubtful = proposal.rows.some((row) => row.doubtful);
  await say(supabase, userId, 'onboarding', 'velsuno', doubtful ? 'Encontré esto. Confirma los datos marcados:' : 'Encontré esto:',
    { title: proposal.title, rows: proposal.rows, actions: [{ kind: 'vision_confirm', label: 'Confirmar' }, { kind: 'vision_discard', label: 'Corregir' }] });
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
  const applied: Record<string, string[]> = {};
  const insert = async (table: string, rows: Array<Record<string, unknown>>) => {
    if (!rows.length) return true;
    const { data, error } = await supabase.from(table).insert(rows).select('id');
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
  const name = preferredName(await loadProfile(supabase));
  await say(supabase, userId, 'onboarding', 'velsuno', `${name ? `Hola, ${name}. ` : 'Hola. '}Vamos a ordenar esto juntos.`);
  await say(supabase, userId, 'onboarding', 'velsuno', 'Cuéntame de tu dinero como te salga: cuánto recibes y cuándo, qué pagos tienes y si debes algo.',
    { actions: [{ kind: 'camera', label: 'Mostrar una foto' }] });
  return { ok: true };
}
