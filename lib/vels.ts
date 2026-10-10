import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { answer, compactView, detectIntent, proactiveNote, STYLE_INSTRUCTION, styleAnswer, velsSuggestions, type Answer, type View } from '../src/ai/vels-answers';
import { validPatches, visionWrites } from '../src/ai/apply';
import type { MessageCard } from '../src/ai/conversation';
import { fold } from '../src/ai/text';
import { ask, asDraft, asResume, COLLECT_PENDING, gapFor, readReply, saidBalance, saidIncome, type CollectPending, type Draft, type Resume } from '../src/ai/vels-collect';
import { interpret } from '../src/ai/interpreter';
import { money } from '../src/ai/draft';
import { validateVelsRoute, VELS_ROUTE_SCHEMA, VELS_ROUTE_SYSTEM } from '../src/ai/vels-route';
import { sanitizeUserText } from '../src/ai/sanitize';
import { greeting, socialKind, socialReply, type Social } from '../src/ai/vels-social';
import { preferredName } from '../src/domain/profile';
import { loadProfile } from './queries';
import { loadPreferences } from './preferences';
import { infer, STOP_TEXT } from './ai';
import { logLearning } from './learning';
import { isReplay } from './idempotency';
import { applyPlan } from './plan-applications';
import { loadCardViews } from './cards';
import { loadMessages, readImages } from './onboarding';
import { loadPlanningData, planFor, planInputFor, planTimeline } from './planning';

/**
 * Vels turns (panel and /app/preguntar, §19-§22, §69): reads the structured financial state (planning engine),
 * never the whole history. Local intents answer most questions at zero AI cost; Gemini only interprets what the
 * rules do not cover, with a compact state + the last few messages. Thread is capped (older messages pruned).
 */
const KEEP = 40;
const NOT_UNDERSTOOD = 'No te entendí bien. ¿Me lo dices de otra forma?';
const SOCIAL: readonly Social[] = ['greeting', 'how', 'how_reply', 'thanks', 'ack', 'bye', 'capabilities', 'follow_up', 'open_order', 'open_spending'];
const UNSURE = /\b(no se|ni idea|tu dime|donde sea|cualquiera|como quieras|por donde sea|no tengo idea)\b/;

async function view(supabase: SupabaseClient): Promise<View> {
  const planning = loadPlanningData(supabase);
  const [d, review, cards] = await Promise.all([
    planning,
    supabase.from('transactions').select('id', { count: 'exact', head: true }).in('status', ['review_required', 'possible_duplicate']),
    loadCardViews(supabase, planning),
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
    cards: cards.map((c) => ({ name: c.name, currency: c.currency, creditLimitMinor: c.limitMinor, statementDay: c.statementDay, paymentDay: c.paymentDay, position: c.position })),
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

export async function velsTurn(supabase: SupabaseClient, userId: string, raw: string): Promise<void> {
  const { text } = sanitizeUserText(raw);
  if (!text) return;
  // One parallel step instead of three sequential round trips: the engine view doesn't depend on the thread.
  const [loaded, v, prefs] = await Promise.all([loadMessages(supabase, 'assistant', 8), view(supabase), loadPreferences(supabase), say(supabase, userId, 'user', text)]);
  // Ajustes → Vels: the style only changes presentation (rows, Gemini's length); the engine's numbers are the same.
  const styled = (a: Answer) => toCard(styleAnswer(a, prefs.velsStyle));
  const history = loaded.at(-1)?.role === 'user' && loaded.at(-1)?.body === text ? loaded.slice(0, -1) : loaded;
  const last = [...history].reverse().find((m) => m.role === 'velsuno');

  // 1. Social turns first (greeting, "¿cómo estás?", thanks, "¿por qué?" about Vels's own line): never the engine,
  //    never numbers, no menu. A question Vels was waiting on stays open across them.
  const lastSocial = SOCIAL.find((s) => s === last?.card?.social) ?? null;
  const pending = last?.card?.pending as CollectPending | undefined;
  const social = socialKind(text, lastSocial);
  if (lastSocial === 'open_order' && UNSURE.test(fold(text))) {
    if (!(await askIfMissing(supabase, userId, { k: 'organize' }, v, 'Empecemos por lo que tienes disponible ahora. ¿Cuánto tienes hoy?'))) {
      const o = answer({ k: 'organize' }, v)!;
      await say(supabase, userId, 'velsuno', o.text, toCard(o));
    }
    await prune(supabase); return;
  }
  if (social) {
    // The name opens a conversation; it is not repeated. A thread with no messages already showed the named welcome.
    const named = social === 'greeting' && history.length > 0 && !history.some((m) => m.role === 'velsuno' && m.card?.social === 'greeting');
    const s = socialReply(social, text, history.length, named ? preferredName(await loadProfile(supabase)) : null);
    const keep = pending && COLLECT_PENDING.includes(pending) ? { pending, resume: last!.card!.resume, draft: last!.card!.draft } : {};
    await say(supabase, userId, 'velsuno', s.text, { social, ...keep, ...(s.link ? { links: [s.link] } : {}) });
    await prune(supabase); return;
  }
  // 2. The answer to Vels's last question (balance, next income…): read deterministically, stored, then the next step.
  if (pending && COLLECT_PENDING.includes(pending) && await collectTurn(supabase, userId, text, pending, last!.card!, v)) { await prune(supabase); return; }
  // Volunteered income while none is registered ("me pagan 4500 el 15"): same path, no question needed first.
  if (!pending && gapFor(v, null) === 'income' && detectIntent(text).k === 'unknown' && interpret(text).patches.some((p) => p.t === 'income')
    && await collectTurn(supabase, userId, text, 'income', {}, v)) { await prune(supabase); return; }

  const intent = detectIntent(text);
  if (await askIfMissing(supabase, userId, intent, v)) { await prune(supabase); return; }
  const a = answer(intent, v);
  if (a) { await say(supabase, userId, 'velsuno', a.text, styled(a)); await prune(supabase); return; }

  // Not recognised locally → Gemini interprets (structured, validated) → the engine answers. The model never computes money.
  const recent = history.slice(-6).map((m) => ({ role: m.role === 'user' ? 'user' as const : 'assistant' as const, content: m.body }));
  const ctx = { state: compactView(v), question: text };
  const r = await infer(supabase, { operation: 'assistant_answer', system: `${VELS_ROUTE_SYSTEM}\n${STYLE_INSTRUCTION[prefs.velsStyle]}`, schema: VELS_ROUTE_SCHEMA,
    messages: [...recent, { role: 'user', content: `ESTADO:\n${ctx.state}\n\nPREGUNTA:\n${text}` }] }, (t) => validateVelsRoute(t, ctx) !== null);
  const route = r.ok ? validateVelsRoute(r.text, ctx) : null;
  if (route?.kind === 'intent' && await askIfMissing(supabase, userId, route.intent, v)) { await prune(supabase); return; }
  const routed = route?.kind === 'intent' ? answer(route.intent, v) : null;
  if (routed) await say(supabase, userId, 'velsuno', routed.text, styled(routed));
  else if (route?.kind === 'reply') await say(supabase, userId, 'velsuno', route.text.slice(0, 600));
  else if (r.ok) await say(supabase, userId, 'velsuno', NOT_UNDERSTOOD);
  else if (r.reason === 'ai_quota') await say(supabase, userId, 'velsuno', STOP_TEXT.ai_quota, { stop: true, links: [{ label: 'Ver Plus', href: '/app/ajustes/plan' }] });
  else if (r.reason === 'unavailable' || r.reason === 'failed') {
    // Timeout, provider error, rate limit, empty or invalid output: a friendly way forward, never a broken thread.
    await say(supabase, userId, 'velsuno', r.reason === 'failed' ? NOT_UNDERSTOOD : 'Eso todavía no sé responderlo. Pregúntame por tu dinero disponible o tus pagos y lo vemos.');
  } else await say(supabase, userId, 'velsuno', STOP_TEXT[r.reason], { stop: true });
  await prune(supabase);
}

/** A money question without today's balance or the next income: ask for the first missing fact, nothing else. */
async function askIfMissing(supabase: SupabaseClient, userId: string, intent: unknown, v: View, opening?: string): Promise<boolean> {
  const resume = asResume(intent);
  const gap = resume ? gapFor(v, resume) : null;
  if (!resume || !gap) return false;
  const q = ask(gap, resume, true);
  await say(supabase, userId, 'velsuno', opening && gap === 'balance' ? opening : q.text, { pending: q.pending, resume });
  return true;
}

const usesUsd = (v: View) => v.plans.some((p) => p.currency === 'USD' && (p.base || p.lines.length)) || v.debts.some((d) => d.currency === 'USD') || v.obligations.some((o) => o.currency === 'USD');

/**
 * One step of the progressive conversation: read the reply, store what it says through the usual tables (a snapshot
 * for the balance, an expected income with a one-time client_ref), then ask the next missing fact or let the engine
 * answer the question that started it. Never overwrites an income that exists. Returns false to let the normal
 * flow handle a message that is really a new question.
 */
async function collectTurn(supabase: SupabaseClient, userId: string, text: string, pending: CollectPending, card: MessageCard, v: View): Promise<boolean> {
  // A new question ("¿me alcanza para 300?") is never read as the answer, even if it carries a number.
  if (detectIntent(text).k !== 'unknown') return false;
  const resume: Resume | null = asResume(card.resume);
  const r = readReply(pending, asDraft(card.draft), text, v.today, usesUsd(v));
  if (r.kind === 'none') {
    const again = pending === 'balance' || pending === 'currency' ? 'No alcancé a leer el monto. ¿Cuánto tienes hoy? Un aproximado me sirve.'
      : '¿Qué día vuelves a recibir dinero y cuánto? Por ejemplo: "el 15, 4500".';
    await say(supabase, userId, 'velsuno', again, { pending, resume, draft: card.draft as Draft });
    return true;
  }
  if (r.kind === 'ask') { await say(supabase, userId, 'velsuno', r.text, { pending: r.pending, resume, draft: r.draft, ...(r.replies ? { replies: r.replies } : {}) }); return true; }
  let said = '';
  if (r.kind === 'balance') {
    const { error } = await supabase.from('balance_snapshots').insert({ user_id: userId, currency: r.currency, amount_minor: r.minor });
    if (error) { await say(supabase, userId, 'velsuno', 'No pude guardar tu saldo. Intenta de nuevo.', { pending: 'balance', resume }); return true; }
    said = saidBalance(r.minor, r.currency);
  } else {
    const i = r.income;
    // An income that already exists is never replaced from the chat (ask, don't overwrite).
    const plan = v.plans.find((p) => p.currency === i.currency);
    if (plan?.nextIncome) {
      await say(supabase, userId, 'velsuno', `Ya tengo un ingreso el ${Number(plan.nextIncome.date.slice(8))}. Si cambió, edítalo en Dinero disponible para no duplicarlo.`, { links: [{ label: 'Ver Dinero libre', href: '/app/plan' }] });
      return true;
    }
    const { error } = await supabase.from('expected_incomes').insert({
      user_id: userId, name: 'Ingreso', currency: i.currency, amount_minor: i.amountMinor,
      amount_status: i.amountMinor === null ? 'unknown' : i.approx ? 'estimated' : 'confirmed',
      frequency: i.secondDay ? 'semimonthly' : 'monthly', day_of_month: i.day, second_day: i.secondDay, client_ref: `vels:${crypto.randomUUID()}`,
    });
    if (error) { await say(supabase, userId, 'velsuno', 'No pude guardar tu ingreso. Intenta de nuevo.', { pending: 'income', resume }); return true; }
    await logLearning(supabase, userId, 'income', 'accepted', null, { source: 'vels', day: i.day, currency: i.currency });
    said = saidIncome(i);
  }
  const v2 = await view(supabase);
  const next = resume ?? { k: 'free' as const };
  const gap = gapFor(v2, next);
  if (gap) { const q = ask(gap, next, false, said); await say(supabase, userId, 'velsuno', q.text, { pending: q.pending, resume: next }); return true; }
  // Everything the question needs is stored: the engine answers.
  // "¿Cuánto tengo?" / "¿Cuándo me pagan?": what the person just said is the whole answer.
  if (next.k === 'balance' || next.k === 'next_income') { await say(supabase, userId, 'velsuno', said); return true; }
  const a = answer(next, v2)!;
  await say(supabase, userId, 'velsuno', `${said} ${a.text}`, toCard(a));
  return true;
}

/** Buttons in assistant answers: deterministic domain writes, never inference (§55). */
export async function velsAct(supabase: SupabaseClient, userId: string, act: string, fields: Record<string, string>): Promise<string> {
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
    if (isReplay(error)) {
      const { data: prev } = await supabase.from('debts').select('active').eq('client_ref', clientRef!).maybeSingle();
      return prev?.active === false ? 'Esa deuda ya no está activa. Si es otra, dímelo de nuevo.' : 'Ya la tenía guardada.';
    }
    if (error) return 'No pude guardarla.';
    await logLearning(supabase, userId, 'obligation', 'accepted', data.id, { kind: 'debt', lender, amount, currency });
    return `Listo. Debes ${money(amount, currency)} a ${lender}. No la cuento en Dinero disponible hasta que tenga fecha.`;
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
export async function velsImages(supabase: SupabaseClient, userId: string, files: File[]): Promise<void> {
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
export async function velsVision(supabase: SupabaseClient, userId: string, confirm: boolean): Promise<void> {
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

export async function clearVels(supabase: SupabaseClient) {
  await supabase.from('conversation_messages').delete().eq('thread', 'assistant');
}

/** Opening Vels (bubble or page): recent conversation + up to 3 openers from the real state and the current screen. */
export async function velsOpen(supabase: SupabaseClient, path: string): Promise<{ messages: Awaited<ReturnType<typeof loadMessages>>; suggestions: string[]; greeting: string }> {
  const [messages, v, profile, prefs] = await Promise.all([loadMessages(supabase, 'assistant', KEEP), view(supabase), loadProfile(supabase), loadPreferences(supabase)]);
  // Shown only when the thread is empty (start of a conversation); the opener varies by day, not by reload.
  // Proactive suggestions (Ajustes → Vels): at most one useful line before the question, never a list.
  const hello = greeting(preferredName(profile), Number(v.today.slice(8, 10)));
  const note = prefs.velsProactive ? proactiveNote(v) : null;
  return { messages, suggestions: velsSuggestions(v, path), greeting: note ? hello.replace(/ (¿[^?]*\?)$/, (_, q: string) => ` ${note} ${q}`) : hello };
}
