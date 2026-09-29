import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { answer, compactView, detectIntent, velsSuggestions, type Answer, type View } from '../src/ai/assistant';
import { validPatches, visionWrites } from '../src/ai/apply';
import type { MessageCard } from '../src/ai/conversation';
import { findAmounts, fold } from '../src/ai/text';
import { money } from '../src/ai/draft';
import { ASSISTANT_SYSTEM } from '../src/ai/prompts';
import { sanitizeUserText } from '../src/ai/sanitize';
import { isSmallTalk } from '../src/ai/interpreter';
import { infer, STOP_TEXT } from './ai';
import { logLearning } from './learning';
import { isReplay } from './idempotency';
import { applyPlan } from './plan-applications';
import { loadMessages, readImages } from './onboarding';
import { loadPlanningData, planFor, planInputFor, planTimeline } from './planning';

/**
 * "Preguntar" (§19-§22, §69): the assistant reads the structured financial state (planning engine), never the
 * whole history. Deterministic intents answer most questions at zero AI cost; a provider only phrases answers
 * the rules do not cover, with a compact state + the last few messages. Thread is capped (older messages pruned).
 */
const KEEP = 40;

async function view(supabase: SupabaseClient): Promise<View> {
  const [d, review, cards] = await Promise.all([
    loadPlanningData(supabase),
    supabase.from('transactions').select('id', { count: 'exact', head: true }).in('status', ['review_required', 'possible_duplicate']),
    supabase.from('cards').select('alias,currency,credit_limit_minor,statement_day,payment_day').eq('active', true).limit(20),
  ]);
  const currencies = [...new Set<'PEN' | 'USD'>(['PEN', ...d.obligations.map((o) => o.currency), ...d.incomes.map((i) => i.currency), ...(Object.keys(d.balances) as Array<'PEN' | 'USD'>)])];
  return {
    today: d.today,
    plans: currencies.map((c) => planFor(d, c)).filter((p) => p.base || p.lines.length || p.currency === 'PEN'),
    obligations: d.obligations.filter((o) => o.source === 'obligation').map((o) => ({ id: o.id, name: o.name, currency: o.currency, amountMinor: o.amountMinor })),
    debts: d.debts,
    reviewCount: review.count ?? 0,
    suggestions: d.suggestions,
    incomeMatches: d.incomeMatches,
    cards: (cards.data ?? []).map((c) => ({ name: c.alias as string, currency: c.currency, creditLimitMinor: c.credit_limit_minor === null ? null : Number(c.credit_limit_minor), statementDay: c.statement_day, paymentDay: c.payment_day })),
    recentIncome: d.recentIncome,
    timeline: planTimeline(d, 14),
    inputs: Object.fromEntries(currencies.map((c) => [c, planInputFor(d, c)])),
    debtLinks: d.debts.map((x) => ({ ...x, obligationId: d.obligationRows.find((o) => o.active && o.kind === 'card' && o.currency === x.currency && fold(o.name) === fold(x.name))?.id ?? null })),
  };
}

function toCard(a: Answer): MessageCard | null {
  const card: MessageCard = {};
  if (a.title) card.title = a.title;
  if (a.rows?.length) card.rows = a.rows;
  const links = (a.actions ?? []).filter((x) => x.type === 'link') as Array<{ label: string; href: string }>;
  // Writes proposed by Vels carry a one-time reference: two tabs / a replayed request store the row once (ADR-0012).
  const acts = (a.actions ?? []).filter((x) => x.type === 'act')
    .map((x) => (x.type === 'act' && (x.act === 'create_debt' || x.act === 'apply_plan') ? { ...x, fields: { ...x.fields, ref: `vels:${crypto.randomUUID()}` } } : x)) as unknown as MessageCard['acts'];
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
  // One parallel step instead of three sequential round trips: the engine view doesn't depend on the thread.
  const [loaded, v] = await Promise.all([loadMessages(supabase, 'assistant', 8), view(supabase), say(supabase, userId, 'user', text)]);
  const history = loaded.at(-1)?.role === 'user' && loaded.at(-1)?.body === text ? loaded.slice(0, -1) : loaded;
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
  if (act === 'create_debt') {
    // Confirmation required (ADR-0011 class D): a debt the person owes — pending, never marked paid.
    const amount = Number(fields.amount);
    const lender = (fields.lender ?? '').replace(/[^a-zA-ZñÑáéíóúÁÉÍÓÚ ]/g, '').trim().slice(0, 40);
    const currency = fields.currency === 'USD' ? 'USD' : 'PEN';
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1e11 || !lender) return 'No pude guardarla.';
    const name = `Deuda con ${lender}`.slice(0, 60);
    // Idempotent against a double tap: the same debt (name + amount) already open is not created twice.
    const { data: same } = await supabase.from('debts').select('id').eq('name', name).eq('balance_minor', amount).eq('currency', currency).eq('active', true).limit(1);
    if (same?.length) return 'Ya la tenía guardada.';
    const clientRef = /^vels:[0-9a-f-]{36}$/.test(fields.ref ?? '') ? fields.ref! : null;
    const { data, error } = await supabase.from('debts').insert({ user_id: userId, name, lender, currency, principal_minor: amount, balance_minor: amount, client_ref: clientRef }).select('id').single();
    if (isReplay(error)) return 'Ya la tenía guardada.';
    if (error) return 'No pude guardarla.';
    await logLearning(supabase, userId, 'obligation', 'accepted', data.id, { kind: 'debt', lender, amount, currency });
    return `Listo. Debes ${money(amount, currency)} a ${lender}. No la cuento en Dinero libre hasta que tenga fecha.`;
  }
  if (act === 'apply_plan') {
    // Confirmation required: saves the reservations the person saw (ADR-0013). Never pays, moves money or marks paid.
    const currency = fields.currency === 'USD' ? 'USD' : fields.currency === 'PEN' ? 'PEN' : null;
    const num = (x: string | undefined) => (x && /^-?\d{1,13}$/.test(x) ? Number(x) : null);
    if (!currency) return 'No pude aplicarlo.';
    const r = await applyPlan(supabase, await loadPlanningData(supabase), {
      currency, base: 'balance', seen: { freeMinor: num(fields.free), reservedMinor: num(fields.reserved) },
      ref: /^vels:[0-9a-f-]{36}$/.test(fields.ref ?? '') ? fields.ref! : null,
    });
    return r.ok ? `Plan aplicado hasta el ${Number(r.until.slice(8))}/${r.until.slice(5, 7)}. Apartado: ${money(r.reservedMinor, currency)}. No se movió dinero.` : r.error;
  }
  if (act === 'set_essentials') {
    const amount = Number(fields.amount);
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > 1e11) return 'No pude guardarlo.';
    const { error } = await supabase.from('planning_settings').upsert({ user_id: userId, currency: 'PEN', essentials_monthly_minor: amount, essentials_status: 'estimated', updated_at: new Date().toISOString() }, { onConflict: 'user_id,currency' });
    if (error) return 'No pude guardarlo.';
    await logLearning(supabase, userId, 'essentials', 'corrected', null, { to: amount, status: 'estimated' });
    return `Listo. Uso ${money(amount, 'PEN')} al mes para lo básico (estimado). Te aviso si tus gastos dicen otra cosa.`;
  }
  if (act === 'set_pref') {
    if (fields.key !== 'allow_zero_for_debt' || (fields.value !== 'on' && fields.value !== 'off')) return 'No pude guardarlo.';
    const on = fields.value === 'on';
    const { error } = await supabase.from('planning_settings').upsert({ user_id: userId, currency: 'PEN', allow_zero_for_debt: on, updated_at: new Date().toISOString() }, { onConflict: 'user_id,currency' });
    if (error) return 'No pude guardarlo.';
    await logLearning(supabase, userId, 'preference', on ? 'accepted' : 'restored', null, { key: fields.key, value: on });
    return on ? 'Listo. Lo tendré en cuenta al sugerirte abonos.' : 'Listo. Mantengo tu colchón.';
  }
  if (act === 'link_income') {
    if (![fields.incomeId, fields.transactionId].every((x) => /^[0-9a-f-]{36}$/.test(x ?? '')) || !/^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/.test(fields.period ?? '')) return 'No pude registrarlo.';
    const { data: tx } = await supabase.from('transactions').select('type,status').eq('id', fields.transactionId!).maybeSingle();
    if (!tx || tx.type !== 'income' || tx.status !== 'confirmed') return 'Ese movimiento no es un ingreso confirmado.';
    const { error } = await supabase.from('plan_settlements').insert({ user_id: userId, expected_income_id: fields.incomeId, period: fields.period, transaction_id: fields.transactionId });
    if (error) return error.code === '23505' ? 'Ese ingreso ya estaba registrado.' : 'No pude registrarlo.';
    const a = answer({ k: 'free' }, await view(supabase));
    return `Listo, ingreso registrado.${a && !a.pending ? ` ${a.text}` : ''}`;
  }
  return 'No pude hacerlo.';
}

/**
 * Camera in "Preguntar" (§70): same pipeline as onboarding (validate → temporary read → structured facts). The
 * proposal is kept in the Velsuno message row (never sent to the browser) until "Confirmar"; nothing is written
 * before that. The image itself is never stored.
 */
export async function assistantImages(supabase: SupabaseClient, userId: string, files: File[]): Promise<void> {
  const read = await readImages(supabase, files, 'consulta posterior a la configuración', (b) => say(supabase, userId, 'user', b), 'assistant');
  if (!read.ok) { if ('text' in read) await say(supabase, userId, 'velsuno', read.text, read.stop ? { stop: true } : null); return; }
  const { proposal } = read;
  const doubtful = proposal.rows.some((row) => row.doubtful);
  await say(supabase, userId, 'velsuno', doubtful ? 'Encontré esto. Confirma los datos marcados:' : 'Encontré esto:', {
    title: proposal.title, rows: proposal.rows, vision: proposal.patches, readKey: read.readKey,
    actions: [{ kind: 'vision_confirm', label: 'Confirmar' }, { kind: 'vision_discard', label: 'Descartar' }],
  });
  await prune(supabase);
}

/** Only the latest Velsuno message can be confirmed: an older proposal (or a second tap) writes nothing. */
export async function assistantVision(supabase: SupabaseClient, userId: string, confirm: boolean): Promise<void> {
  const { data: last } = await supabase.from('conversation_messages').select('id,card').eq('thread', 'assistant').eq('role', 'velsuno')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  const patches = validPatches((last?.card as MessageCard | null)?.vision);
  if (!patches.length) return;
  await say(supabase, userId, 'user', confirm ? 'Confirmar' : 'Descartar');
  if (!confirm) { await say(supabase, userId, 'velsuno', 'Listo, no guardé nada de la foto.'); return; }
  const [fx, debts, cards] = await Promise.all([
    supabase.from('fixed_expenses').select('id,name,kind,currency').eq('active', true),
    supabase.from('debts').select('id,name,currency').eq('active', true),
    supabase.from('cards').select('last4'),
  ]);
  if (fx.error || debts.error || cards.error) { await say(supabase, userId, 'velsuno', 'No pude guardarlo. Intenta de nuevo.'); return; }
  const w = visionWrites(patches, { obligations: fx.data ?? [], debts: debts.data ?? [], cardLast4: (cards.data ?? []).map((c) => c.last4 as string) }, userId);
  let failed = 0;
  for (const u of w.updates) { const { error } = await supabase.from(u.table).update(u.patch).eq('id', u.id); if (error) failed++; }
  // Deterministic per-proposal references: a concurrent second "Confirmar" cannot insert the same rows again.
  for (const [n, i] of w.inserts.entries()) {
    const row = i.table === 'fixed_expenses' || i.table === 'debts' ? { ...i.row, client_ref: `vis:${last!.id}:${n}` } : i.row;
    const { error } = await supabase.from(i.table).insert(row);
    if (error && !isReplay(error) && !(i.table === 'cards' && error.code === '23505')) failed++;
  }
  const done = w.updates.length + w.inserts.length - failed;
  const a = answer({ k: 'free' }, await view(supabase));
  await say(supabase, userId, 'velsuno', failed
    ? `Guardé ${done} de ${done + failed} datos. Revisa en Próximos pagos.`
    : `Listo, ${w.updates.length ? 'actualicé' : 'guardé'} los datos.${a && !a.pending ? ` ${a.text}` : ''}`,
  { links: [{ label: 'Ver próximos pagos', href: '/app/compromisos' }] });
  await prune(supabase);
}

export async function clearAssistant(supabase: SupabaseClient) {
  await supabase.from('conversation_messages').delete().eq('thread', 'assistant');
}

/** Opening Vels (bubble or page): recent conversation + up to 3 openers from the real state and the current screen. */
export async function velsOpen(supabase: SupabaseClient, path: string): Promise<{ messages: Awaited<ReturnType<typeof loadMessages>>; suggestions: string[] }> {
  const [messages, v] = await Promise.all([loadMessages(supabase, 'assistant', KEEP), view(supabase)]);
  return { messages, suggestions: velsSuggestions(v, path) };
}
