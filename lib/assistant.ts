import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { answer, compactView, detectIntent, type Answer, type View } from '../src/ai/assistant';
import type { MessageCard } from '../src/ai/conversation';
import { findAmounts, fold } from '../src/ai/text';
import { ASSISTANT_SYSTEM } from '../src/ai/prompts';
import { sanitizeUserText } from '../src/ai/sanitize';
import { isSmallTalk } from '../src/ai/interpreter';
import { infer, STOP_TEXT } from './ai';
import { loadMessages } from './onboarding';
import { loadPlanningData, planFor } from './planning';

/**
 * "Preguntar" (§19-§22, §69): the assistant reads the structured financial state (planning engine), never the
 * whole history. Deterministic intents answer most questions at zero AI cost; a provider only phrases answers
 * the rules do not cover, with a compact state + the last few messages. Thread is capped (older messages pruned).
 */
const KEEP = 40;

async function view(supabase: SupabaseClient): Promise<View> {
  const [d, review] = await Promise.all([
    loadPlanningData(supabase),
    supabase.from('transactions').select('id', { count: 'exact', head: true }).in('status', ['review_required', 'possible_duplicate']),
  ]);
  const currencies = [...new Set<'PEN' | 'USD'>(['PEN', ...d.obligations.map((o) => o.currency), ...d.incomes.map((i) => i.currency), ...(Object.keys(d.balances) as Array<'PEN' | 'USD'>)])];
  return {
    today: d.today,
    plans: currencies.map((c) => planFor(d, c)).filter((p) => p.base || p.lines.length || p.currency === 'PEN'),
    obligations: d.obligations.filter((o) => o.source === 'obligation').map((o) => ({ id: o.id, name: o.name, currency: o.currency, amountMinor: o.amountMinor })),
    debts: d.debts,
    reviewCount: review.count ?? 0,
    suggestions: d.suggestions,
  };
}

function toCard(a: Answer): MessageCard | null {
  const card: MessageCard = {};
  if (a.rows?.length) card.rows = a.rows;
  const links = (a.actions ?? []).filter((x) => x.type === 'link') as Array<{ label: string; href: string }>;
  const acts = (a.actions ?? []).filter((x) => x.type === 'act') as unknown as MessageCard['acts'];
  const replies = (a.actions ?? []).filter((x) => x.type === 'reply').map((x) => x.label);
  if (links.length) card.links = links;
  if (acts?.length) card.acts = acts;
  if (replies.length) card.replies = replies;
  if (a.pending) card.pending = a.pending;
  return Object.keys(card).length ? card : null;
}

async function say(supabase: SupabaseClient, userId: string, role: 'user' | 'velsuno', body: string, card: MessageCard | null = null) {
  await supabase.from('conversation_messages').insert({ user_id: userId, thread: 'assistant', role, body: body.slice(0, 2000), card });
}

async function prune(supabase: SupabaseClient) {
  const { data } = await supabase.from('conversation_messages').select('id').eq('thread', 'assistant').order('created_at', { ascending: false }).range(KEEP, KEEP + 200);
  const ids = (data ?? []).map((r) => r.id as string);
  if (ids.length) await supabase.from('conversation_messages').delete().in('id', ids);
}

export async function assistantTurn(supabase: SupabaseClient, userId: string, raw: string): Promise<void> {
  const { text } = sanitizeUserText(raw);
  if (!text) return;
  const history = await loadMessages(supabase, 'assistant', 8);
  await say(supabase, userId, 'user', text);
  const last = [...history].reverse().find((m) => m.role === 'velsuno');

  // A bare amount answers the pending question (e.g. "¿Cuánto tienes ahora?" → "3,200"): deterministic write.
  const amount = findAmounts(fold(text))[0];
  if (last?.card?.pending === 'balance' && amount) {
    const { error } = await supabase.from('balance_snapshots').insert({ user_id: userId, currency: amount.currency ?? 'PEN', amount_minor: amount.minor });
    if (error) { await say(supabase, userId, 'velsuno', 'No pude guardar tu saldo. Intenta de nuevo.'); return; }
    const a = answer({ k: 'free' }, await view(supabase))!;
    await say(supabase, userId, 'velsuno', `Saldo guardado. ${a.text}`, toCard(a));
    await prune(supabase);
    return;
  }
  if (isSmallTalk(text)) { await say(supabase, userId, 'velsuno', '¿Algo más en lo que te ayude?'); return; }

  const v = await view(supabase);
  const a = answer(detectIntent(text), v);
  if (a) { await say(supabase, userId, 'velsuno', a.text, toCard(a)); await prune(supabase); return; }

  const recent = history.slice(-6).map((m) => ({ role: m.role === 'user' ? 'user' as const : 'assistant' as const, content: m.body }));
  const r = await infer(supabase, { operation: 'assistant_answer', system: ASSISTANT_SYSTEM, json: false,
    messages: [...recent, { role: 'user', content: `ESTADO:\n${compactView(v)}\n\nPREGUNTA:\n${text}` }] }, (t) => t.trim().length > 0 && t.length < 1500);
  if (r.ok) await say(supabase, userId, 'velsuno', r.text.trim().slice(0, 600));
  else if (r.reason === 'ai_quota') await say(supabase, userId, 'velsuno', STOP_TEXT.ai_quota, { stop: true, links: [{ label: 'Ver Plus', href: '/app/cuenta' }] });
  else if (r.reason === 'unavailable') {
    await say(supabase, userId, 'velsuno', 'Todavía no sé responder eso. Puedo decirte cuánto tienes libre, qué pagos vienen, si te alcanza para una compra o qué pagar primero.',
      { replies: ['¿Cuánto tengo libre?', '¿Qué viene esta semana?', '¿Qué pago primero?'] });
  } else await say(supabase, userId, 'velsuno', STOP_TEXT[r.reason], { stop: true });
  await prune(supabase);
}

/** Buttons in assistant answers: deterministic domain writes, never inference (§55). */
export async function assistantAct(supabase: SupabaseClient, userId: string, act: string, fields: Record<string, string>): Promise<string> {
  if (act === 'patch_obligation') {
    const amount = Number(fields.amount);
    const minor = Math.round(amount * 100);
    if (!Number.isFinite(amount) || minor <= 0 || !/^[0-9a-f-]{36}$/.test(fields.id ?? '')) return 'No pude actualizarlo.';
    const { error } = await supabase.from('fixed_expenses').update({ amount_minor: minor, amount_status: 'confirmed', updated_at: new Date().toISOString() }).eq('id', fields.id!);
    return error ? 'No pude actualizarlo.' : 'Listo, actualizado.';
  }
  if (act === 'mark_paid') {
    if (![fields.obligationId, fields.transactionId].every((x) => /^[0-9a-f-]{36}$/.test(x ?? '')) || !/^\d{4}-\d{2}$/.test(fields.period ?? '')) return 'No pude marcarlo.';
    const { error } = await supabase.from('plan_settlements').insert({ user_id: userId, fixed_expense_id: fields.obligationId, period: fields.period, transaction_id: fields.transactionId });
    return error ? 'No pude marcarlo. Puede que ya esté enlazado.' : 'Listo, marcado como pagado.';
  }
  return 'No pude hacerlo.';
}

export async function clearAssistant(supabase: SupabaseClient) {
  await supabase.from('conversation_messages').delete().eq('thread', 'assistant');
}
