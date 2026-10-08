import type { Currency } from '../domain/money';
import type { IncomeMatch, TimelineItem } from '../engine/observed';
import { compareDebtStrategies, simulatePurchase, type MatchSuggestion, type Plan, type PlanInput } from '../engine/planning';
import { cardCycle, changeBill, delayIncome, extraDebtPayment, payDebt, type ScenarioResult } from '../engine/scenarios';
import type { AssistantAct } from './conversation';
import type { CardPosition } from '../engine/cards';
import { money } from './draft';
import { findAmounts, fold } from './text';

/**
 * Assistant after onboarding (§19-§22, §69): questions are routed to deterministic domain answers first. Numbers
 * always come from the planning engine; a provider is only asked when no intent matches (and only if enabled).
 */
export type Intent =
  | { k: 'free' } | { k: 'can_spend'; amountMinor: number; currency: Currency } | { k: 'upcoming'; range: 'week' | 'next' }
  | { k: 'pay_first' } | { k: 'how' } | { k: 'why_free' } | { k: 'paid'; name: string } | { k: 'got_paid' }
  | { k: 'update_amount'; name: string; amountMinor: number } | { k: 'income_changed'; amountMinor: number | null } | { k: 'debt_paid'; name: string }
  | { k: 'changed' } | { k: 'help' } | { k: 'unknown' }
  | { k: 'card_limit' } | { k: 'organize' } | { k: 'pay_min' } | { k: 'owe'; amountMinor: number; currency: Currency; lender: string }
  | { k: 'estimate_basics'; amountMinor: number } | { k: 'apply_plan' }
  | { k: 'pref_zero_debt'; on: boolean } | { k: 'what_pay_debt'; amountMinor: number; target: string } | { k: 'what_delay'; days: number | null } | { k: 'what_bill'; name: string; amountMinor: number };

const NAMES = ['carro', 'auto', 'alquiler', 'internet', 'luz', 'agua', 'gas', 'celular', 'telefono', 'tarjeta', 'seguro', 'colegio', 'universidad', 'netflix', 'spotify', 'gimnasio', 'prestamo', 'cable'];
const nameIn = (t: string) => NAMES.find((n) => new RegExp(`\\b${n}\\b`).test(t)) ?? null;

export function detectIntent(message: string): Intent {
  const t = fold(message);
  const amount = findAmounts(t)[0];
  const name = nameIn(t);
  // Vels (ADR-0011): card operating limit, organize until the next income, minimum vs total, "le debo X a Y", estimates.
  if (/\btarjeta\b/.test(t) && /\b(hasta cuanto|cuanto) (puedo|podria) (usar|gastar)\b|\blimite (real|de mi tarjeta)\b/.test(t)) return { k: 'card_limit' };
  // "Aplicar plan" (ADR-0013): saves reservations after confirmation; never pays or moves money.
  if (/\b(aplica|aplicar|aplicalo|guarda|guardar|guardalo|fija|fijar|deja|dejar|dejame) (el |este |mi |ese )?(plan|reparto)\b|\b(apartalo|aparta (la |mi )?plata|reserva(lo|r)? (todo|eso))\b/.test(t)) return { k: 'apply_plan' };
  if (/\bque hago con mi (sueldo|plata|dinero|pago)\b|\borganiza(me|r)?( mi| mis)? (dinero|plata|sueldo|pagos)\b|\borganizalos\b|\bcomo llego al proximo (sueldo|ingreso|pago)\b/.test(t)) return { k: 'organize' };
  if (/\b(pago|pagar|pagamos) (solo )?(el )?minimo\b|\bminimo o (el )?total\b|\bpago (el )?total\b.*\btarjeta\b/.test(t)) return { k: 'pay_min' };
  const owe = t.match(/\b(le debo|tengo que pagarle|tengo que devolverle|debo)\b.*?\ba (mi |la |el |)([a-zñ]{3,20})\b/);
  if (owe && amount && !/\b(banco|tarjeta|visa|prestamo)\b/.test(t)) return { k: 'owe', amountMinor: amount.minor, currency: amount.currency ?? 'PEN', lender: `${owe[2] === 'mi ' ? 'tu ' : owe[2]}${owe[3]}` };
  if (amount && /\b(comida|basicos|mercado|lo basico)\b/.test(t) && /\b(pongamosle|pongale|pon|creo|como|unos|aprox|mas o menos|calculo)\b/.test(t)) return { k: 'estimate_basics', amountMinor: amount.minor };
  // Stated preference (§12): recorded only after the person confirms; the trade-off is shown first.
  if (/\bno quiero quedarme en cero\b|\b(quiero|prefiero) (guardar|tener|dejar) (algo|un colchon|colchon)\b/.test(t)) return { k: 'pref_zero_debt', on: false };
  if (/\b(no me importa|me da igual|no hay problema)\b.*\b(cero|nada|sin plata|sin nada)\b/.test(t) || /\bprefiero pagar (la |mis )?deudas?\b/.test(t)) return { k: 'pref_zero_debt', on: true };
  // What-if (simulated, never written): "¿qué pasa si pago 1000 a la tarjeta?", "¿y si mi sueldo se retrasa 5 días?"
  const hypo = /\b(que pasa si|y si|si)\b/.test(t);
  if (hypo && amount && /\bpago\b|\babono\b|\badelanto\b/.test(t) && /\b(tarjeta|visa|mastercard|amex|prestamo|deuda)\b/.test(t)) {
    return { k: 'what_pay_debt', amountMinor: amount.minor, target: t.match(/\b(tarjeta|visa|mastercard|amex|prestamo|deuda)\b/)![1]! };
  }
  if (/\b(retras|atras|demor)\w*|\bllega tarde\b|\bno me pagan a tiempo\b/.test(t) && /\b(sueldo|pago|ingreso|me pagan|quincena|\d{1,2}\s*dias?)\b/.test(t)) {
    const d = t.match(/\b(\d{1,2})\s*dias?\b/);
    return { k: 'what_delay', days: d ? Number(d[1]) : null };
  }
  if (hypo && name && amount && /\b(sube|subiera|aumenta|aumentara|cuesta|costara|fuera)\b/.test(t)) return { k: 'what_bill', name, amountMinor: amount.minor };
  if (/\b(puedo|me alcanza|alcanza|podria) .*(gastar|comprar|pagar|para)\b|\bme alcanza\b/.test(t) && amount) return { k: 'can_spend', amountMinor: amount.minor, currency: amount.currency ?? 'PEN' };
  if (/\bpor que\b.*\b(libre|tengo solo|me queda|poco)\b|\bexplica(me)?\b.*\blibre\b|\bmuestrame por que\b/.test(t)) return { k: 'why_free' };
  if (/\b(cuanto|que) (puedo gastar|tengo libre|queda libre|me queda|tengo disponible)\b|\bdinero libre\b|\bcuanto (hay|queda) libre\b/.test(t)) return { k: 'free' };
  if (/\b(que|cuales) pag(o|os)\b.*\bprimero\b|\bque pago primero\b|\bpriorizo\b/.test(t)) return { k: 'pay_first' };
  if (/\b(esta semana|proximos dias|que viene)\b/.test(t)) return { k: 'upcoming', range: 'week' };
  if (/\b(que|cuales) (tengo que|debo) pagar\b|\bproximos pagos\b|\bque pagos (tengo|vienen)\b|\bque vence\b/.test(t)) return { k: 'upcoming', range: 'next' };
  if (/\b(como voy|como estoy|resumen)\b/.test(t)) return { k: 'how' };
  if (/\b(que cambio|por que gaste mas|gaste mas)\b/.test(t)) return { k: 'changed' };
  if (/\b(ya me pagaron|me pagaron|me depositaron|cobre|llego (mi|el) sueldo)\b/.test(t)) return { k: 'got_paid' };
  if (/\b(cambie de sueldo|nuevo sueldo|ahora gano|me subieron|me bajaron)\b/.test(t)) return { k: 'income_changed', amountMinor: amount?.minor ?? null };
  if (/\b(ya (la |lo )?pague|termine de pagar|cancele)\b.*\b(deuda|prestamo)\b/.test(t)) return { k: 'debt_paid', name: name ?? 'deuda' };
  if (/\b(pague|ya pague|pagado)\b/.test(t) && name) return { k: 'paid', name };
  if (name && amount && /\b(ahora|cuesta|sube|subio|es|son|paga)\b/.test(t)) return { k: 'update_amount', name, amountMinor: amount.minor };
  if (/^(ayuda|help|que puedes hacer|hola|buenas)\b/.test(t)) return { k: 'help' };
  return { k: 'unknown' };
}

export interface View {
  today: string;
  plans: Plan[];
  obligations: Array<{ id: string; name: string; currency: Currency; amountMinor: number | null }>;
  debts: Array<{ id: string; name: string; currency: Currency; balanceMinor: number; annualRateBp: number | null }>;
  reviewCount: number;
  suggestions: MatchSuggestion[];
  incomeMatches?: IncomeMatch[];
  cards?: Array<{ name: string; currency: Currency; creditLimitMinor: number | null; statementDay?: number | null; paymentDay?: number | null; position?: CardPosition }>;
  recentIncome?: { amountMinor: number; currency: Currency; date: string } | null;
  timeline?: TimelineItem[];
  /** Plan inputs per currency, for what-if scenarios (simulated copies; nothing is written). */
  inputs?: Partial<Record<Currency, PlanInput>>;
  debtLinks?: Array<{ id: string; name: string; currency: Currency; balanceMinor: number; annualRateBp: number | null; obligationId: string | null }>;
}
export type Action =
  | { type: 'link'; label: string; href: string }
  | { type: 'act'; label: string; act: AssistantAct; fields: Record<string, string> }
  | { type: 'reply'; label: string };
export interface Answer { title?: string; text: string; rows?: Array<{ label: string; value: string }>; actions?: Action[]; pending?: 'balance' }

const dm = (d: string) => `${Number(d.slice(8, 10))} ${['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'set', 'oct', 'nov', 'dic'][Number(d.slice(5, 7)) - 1]}`;
const primary = (v: View) => v.plans.find((p) => p.base) ?? v.plans[0] ?? null;
const PLAN_LINK: Action = { type: 'link', label: 'Ver Dinero libre', href: '/app/plan' };
/** Confirmation button for "Aplicar plan": carries what the person saw so a changed plan is not saved blindly. */
const applyAct = (p: Plan): Action => ({ type: 'act', label: 'Aplicar plan', act: 'apply_plan', fields: { currency: p.currency, free: String(p.freeMinor), reserved: String(p.reservedMinor) } });

function missingText(p: Plan): string | null {
  const m = p.missing.find((x) => x.code === 'balance' || x.code === 'next_income' || x.code === 'amount');
  return m ? m.text : null;
}

/** Deterministic answer, or null when the question needs a provider (unknown intent). */
export function answer(intent: Intent, v: View): Answer | null {
  const p = primary(v);
  switch (intent.k) {
    case 'free': {
      if (!p || p.freeMinor === null) return { text: `Para calcular cuánto tienes libre necesito ${p?.missing[0]?.text.replace(/\.$/, '').toLowerCase() ?? 'tu saldo de hoy y tu próximo ingreso'}.`, actions: [PLAN_LINK], pending: !p?.base ? 'balance' : undefined };
      const until = p.until ? ` hasta el ${dm(p.until)}` : '';
      return {
        text: p.freeMinor >= 0 ? `Tienes ${money(p.freeMinor, p.currency)} libres${until}${p.status !== 'confirmed' ? ' (estimado)' : ''}.` : `Te faltan ${money(-p.freeMinor, p.currency)} para cubrir lo que viene${until}.`,
        rows: [{ label: 'Tienes', value: money(p.base!.amountMinor, p.currency) }, { label: 'Separado para pagos', value: money(p.reservedMinor, p.currency) }],
        actions: [PLAN_LINK],
      };
    }
    case 'can_spend': {
      const plan = v.plans.find((x) => x.currency === intent.currency) ?? p;
      if (!plan) return { text: 'Aún no tengo tu saldo ni tu próximo ingreso para responder eso.', actions: [PLAN_LINK] };
      const sim = simulatePurchase(plan, intent.amountMinor);
      if (!sim) return { text: `Para saber si te alcanza necesito ${missingText(plan)?.replace(/\.$/, '').toLowerCase() ?? 'tu saldo de hoy'}.`, actions: [PLAN_LINK], pending: !plan.base ? 'balance' : undefined };
      return sim.covered
        ? { text: `Sí. Después de gastar ${money(intent.amountMinor, plan.currency)} te quedarían ${money(sim.afterMinor, plan.currency)} libres${sim.estimated ? ' (estimado)' : ''}.` }
        : { text: `No te alcanza sin tocar lo separado: te faltarían ${money(sim.shortfallMinor, plan.currency)}.`, actions: [PLAN_LINK] };
    }
    case 'upcoming': {
      if (!p) return { text: 'Aún no tienes pagos registrados.', actions: [{ type: 'link', label: 'Agregar pagos', href: '/app/compromisos' }] };
      const horizon = intent.range === 'week' ? dateAdd(v.today, 7) : '9999-12-31';
      const lines = v.plans.flatMap((x) => x.lines.filter((l) => (l.kind === 'payment' || l.kind === 'overdue' || l.kind === 'debt') && (l.date === null || l.date <= horizon)).map((l) => ({ l, cur: x.currency })));
      if (!lines.length) return { text: intent.range === 'week' ? 'Esta semana no tienes pagos pendientes.' : 'No tienes pagos pendientes antes de tu próximo ingreso.' };
      return {
        text: intent.range === 'week' ? 'Esto viene esta semana:' : 'Esto tienes que pagar antes de tu próximo ingreso:',
        rows: lines.slice(0, 6).map(({ l, cur }) => ({ label: `${l.label}${l.kind === 'overdue' ? ' (vencido)' : ''}`, value: `${l.amountMinor === null ? 'monto por confirmar' : money(l.amountMinor, cur)}${l.date ? ` · ${dm(l.date)}` : ''}` })),
        actions: [{ type: 'link', label: 'Ver próximos pagos', href: '/app/compromisos' }],
      };
    }
    case 'pay_first': {
      const overdue = v.plans.flatMap((x) => x.lines.filter((l) => l.kind === 'overdue'));
      const next = v.plans.flatMap((x) => x.lines.filter((l) => l.kind === 'payment' || l.kind === 'debt')).sort((a, b) => (a.date ?? '9').localeCompare(b.date ?? '9'))[0];
      const strategy = v.debts.length > 1 ? compareDebtStrategies(v.debts) : null;
      const parts: string[] = [];
      if (overdue.length) parts.push(`Primero lo vencido: ${overdue.map((l) => l.label).join(', ')}.`);
      else if (next) parts.push(`Lo siguiente es ${next.label}${next.date ? ` (${dm(next.date)})` : ''}.`);
      if (strategy?.avalanche.available && strategy.avalanche.order[0]) parts.push(`Con tus deudas, abona extra a ${strategy.avalanche.order[0]}: es la de mayor interés.`);
      else if (strategy?.snowball.order[0]) parts.push(`Si quieres ver avance rápido, termina primero ${strategy.snowball.order[0]}: es la más pequeña.`);
      return parts.length ? { text: parts.join(' '), actions: [{ type: 'link', label: 'Ver próximos pagos', href: '/app/compromisos' }] } : { text: 'No tienes pagos pendientes ahora.' };
    }
    case 'how': {
      const rows: Array<{ label: string; value: string }> = [];
      for (const x of v.plans) if (x.freeMinor !== null) rows.push({ label: `Libre (${x.currency})`, value: money(x.freeMinor, x.currency) });
      if (v.reviewCount) rows.push({ label: 'Por revisar', value: String(v.reviewCount) });
      const miss = p?.missing[0]?.text;
      return { text: rows.length ? 'Así vas:' : `Aún me falta información. ${miss ?? ''}`.trim(), rows, actions: [PLAN_LINK] };
    }
    case 'why_free': {
      if (!p || p.freeMinor === null || !p.base) return answer({ k: 'free' }, v);
      return {
        text: `Tienes ${money(p.base.amountMinor, p.currency)} y separamos ${money(p.reservedMinor, p.currency)} para lo que viene${p.until ? ` hasta el ${dm(p.until)}` : ''}. Por eso quedan ${money(p.freeMinor, p.currency)}.`,
        rows: p.lines.slice(0, 6).map((l) => ({ label: l.label, value: l.amountMinor === null ? 'monto por confirmar' : money(l.amountMinor, p.currency) })),
        actions: [PLAN_LINK],
      };
    }
    case 'paid': {
      const o = v.obligations.find((x) => fold(x.name).includes(intent.name));
      if (!o) return { text: `No tengo registrado un pago de ${intent.name}. ¿Quieres agregarlo?`, actions: [{ type: 'link', label: 'Agregar pago', href: '/app/compromisos' }] };
      const s = v.suggestions.find((x) => x.obligationId === o.id);
      if (s) return { text: `Encontré un movimiento que parece el pago de ${o.name}. ¿Es este?`, actions: [{ type: 'act', label: 'Sí, marcar pagado', act: 'mark_paid', fields: { obligationId: o.id, transactionId: s.transactionId, period: s.period } }] };
      return { text: `Cuando vea el movimiento del pago de ${o.name}, lo enlazo. Si fue en efectivo, regístralo como movimiento.`, actions: [{ type: 'link', label: 'Registrar movimiento', href: '/app/movimientos/nuevo' }] };
    }
    case 'update_amount': {
      const o = v.obligations.find((x) => fold(x.name).includes(intent.name));
      if (!o) return null;
      return { text: `¿Actualizo ${o.name} a ${money(intent.amountMinor, o.currency)}?`, actions: [{ type: 'act', label: `Actualizar a ${money(intent.amountMinor, o.currency)}`, act: 'patch_obligation', fields: { id: o.id, amount: (intent.amountMinor / 100).toFixed(2) } }] };
    }
    case 'got_paid': {
      // A real deposit that looks like the expected income: the person confirms the link (never automatic).
      const m = v.incomeMatches?.[0];
      if (m?.candidates) {
        return {
          text: `Vi un ingreso de ${money(m.receivedMinor, m.currency)}. ¿Cuál es?`,
          actions: m.candidates.map((c) => ({ type: 'act' as const, label: `Es ${c.name.toLowerCase()}`, act: 'link_income' as const, fields: { incomeId: c.incomeId, transactionId: m.transactionId, period: c.period } })),
        };
      }
      if (m) {
        return {
          text: `Vi un ingreso de ${money(m.receivedMinor, m.currency)}. ¿Es tu ${m.name.toLowerCase()} del ${dm(m.expectedDate)}?`,
          actions: [{ type: 'act', label: 'Sí, es ese', act: 'link_income', fields: { incomeId: m.incomeId, transactionId: m.transactionId, period: m.period } }, PLAN_LINK],
        };
      }
      return { text: 'Qué bien. ¿Cuánto tienes ahora disponible? Con eso recalculo lo que tienes libre.', pending: 'balance' };
    }
    case 'income_changed':
      return { text: 'Lo actualizo desde Dinero libre para que no cambie un ingreso por error.', actions: [{ type: 'link', label: 'Editar ingreso', href: '/app/plan' }] };
    case 'debt_paid':
      return { text: 'Buena noticia. Marca la deuda como pagada en Próximos pagos para que deje de contarse.', actions: [{ type: 'link', label: 'Ver deudas', href: '/app/compromisos' }] };
    case 'changed':
      return { text: 'La comparación con el mes anterior está en Análisis.', actions: [{ type: 'link', label: 'Ver análisis', href: '/app/analisis' }] };
    case 'pref_zero_debt': {
      const act: Action = { type: 'act', label: intent.on ? 'Sí, guardar' : 'Sí, cambiar', act: 'set_pref', fields: { key: 'allow_zero_for_debt', value: intent.on ? 'on' : 'off' } };
      if (!intent.on) return { text: 'Entendido: mantengo tu colchón aunque pagues deuda. ¿Lo cambio?', actions: [act] };
      const plan = v.plans.find((x) => x.currency === 'PEN');
      const x = plan ? extraDebtPayment(plan, v.debts.filter((d) => d.currency === 'PEN'), true) : null;
      const trade = x ? ` Hoy podrías abonar ${money(x.amountMinor, 'PEN')}${x.target ? ` a ${x.target}` : ''}${x.usesCushion ? `, quedando en S/ 0${x.until ? ` hasta el ${dm(x.until)}` : ''}` : ''}.` : '';
      return { text: `Entendido: si pagas deuda, puedes quedarte en cero.${trade} ¿Lo guardo?`, actions: [act] };
    }
    case 'what_pay_debt': {
      const input = v.inputs?.PEN;
      const debts = (v.debtLinks ?? []).filter((d) => d.currency === 'PEN');
      const want = intent.target === 'deuda' ? null : intent.target;
      const debt = debts.find((d) => want && fold(d.name).includes(want)) ?? (debts.length === 1 ? debts[0] : want === 'tarjeta' || want === 'visa' ? debts.find((d) => d.obligationId) : undefined);
      if (!debt) return { text: debts.length ? `¿A cuál? ${debts.map((d) => d.name).join(', ')}.` : 'No tengo deudas registradas.', actions: [{ type: 'link', label: 'Ver deudas', href: '/app/compromisos' }] };
      if (!input?.base) return { text: 'Para simularlo necesito saber cuánto tienes disponible hoy. ¿Cuánto es?', pending: 'balance' };
      const r = payDebt(input, debt, intent.amountMinor)!;
      const d = r.debt!;
      return { text: `Si pagas ${money(Math.min(intent.amountMinor, d.balanceBeforeMinor), 'PEN')} a ${debt.name}: ${freeText(r)}`,
        rows: [{ label: 'Deuda después', value: money(d.balanceAfterMinor, 'PEN') }, ...(d.monthlyInterestSavedMinor ? [{ label: 'Interés que evitas', value: `~${money(d.monthlyInterestSavedMinor, 'PEN')} al mes` }] : [])],
        actions: [PLAN_LINK] };
    }
    case 'what_delay': {
      const input = v.inputs?.PEN;
      if (intent.days === null) return { text: '¿Cuántos días se retrasaría?', actions: [{ type: 'reply', label: 'Retraso de 3 días' }, { type: 'reply', label: 'Retraso de 7 días' }, { type: 'reply', label: 'Retraso de 15 días' }] };
      if (!input?.base) return { text: 'Para simularlo necesito saber cuánto tienes disponible hoy. ¿Cuánto es?', pending: 'balance' };
      const r = delayIncome(input, intent.days);
      if (!r || r.until === null) return { text: 'Para simularlo necesito saber cuándo recibes tu próximo ingreso. Pregúntame cuánto tienes libre y lo vemos.', actions: [PLAN_LINK] };
      return { text: `Si tu ingreso llega ${intent.days} días después: ${freeText(r)}`, rows: r.uncovered.length ? [{ label: 'No alcanzaría para', value: r.uncovered.join(', ') }] : undefined, actions: [PLAN_LINK] };
    }
    case 'what_bill': {
      const o = v.obligations.find((x) => fold(x.name).includes(intent.name));
      const input = o ? v.inputs?.[o.currency] : undefined;
      if (!o || !input) return { text: `No tengo registrado ${intent.name}.`, actions: [{ type: 'link', label: 'Agregar pago', href: '/app/compromisos' }] };
      const r = changeBill(input, o.id, intent.amountMinor);
      if (!r || r.freeAfterMinor === null) return { text: 'Me falta tu saldo o tu próximo ingreso para simularlo.', actions: [PLAN_LINK] };
      return { text: `Si ${o.name} sube a ${money(intent.amountMinor, o.currency)}: ${freeText(r)}`, actions: [PLAN_LINK] };
    }
    case 'card_limit': {
      if (!p || p.freeMinor === null) return { text: 'Para calcularlo me falta tu saldo de hoy y tu próximo ingreso.', actions: [PLAN_LINK], pending: !p?.base ? 'balance' : undefined };
      const bank = (v.cards ?? []).find((c) => c.currency === p.currency && c.creditLimitMinor);
      const withDays = (v.cards ?? []).find((c) => c.currency === p.currency && c.statementDay && c.paymentDay);
      const pos = (v.cards ?? []).find((c) => c.currency === p.currency && c.position?.billed)?.position ?? null;
      const cycle = withDays ? cardCycle(v.today, withDays.statementDay!, withDays.paymentDay!) : null;
      // Real usable: plan free, capped by the bank room when the used amount is known (ADR-0014).
      const real = pos?.usableMinor ?? Math.max(0, p.freeMinor);
      const rows: Array<{ label: string; value: string }> = [{ label: 'Por qué', value: 'Lo que podrías pagar completo sin tocar tus pagos' }];
      if (pos?.billed) {
        rows.push({ label: 'Facturado', value: `${pos.billed.amountMinor === null ? 'por confirmar' : money(pos.billed.amountMinor, p.currency)} · vence ${dm(pos.billed.dueDate)}` });
        if (pos.postCutMinor) rows.push({ label: 'Después del corte', value: `${money(pos.postCutMinor, p.currency)} (va al próximo estado)` });
        if (pos.bankAvailableMinor !== null) rows.push({ label: 'Disponible del banco', value: money(pos.bankAvailableMinor, p.currency) });
      } else if (cycle) rows.push({ label: 'Lo facturado vence', value: `${dm(cycle.dueOfBilled)} (paga el total y no hay interés)` });
      if (cycle) rows.push({ label: 'Lo que compres hoy', value: `se paga el ${dm(cycle.dueOfToday)}` });
      return {
        text: `${bank ? `El banco te permite ${money(bank.creditLimitMinor!, p.currency)}. ` : ''}Para este ciclo, tu límite real es ${money(real, p.currency)}${p.status !== 'confirmed' ? ' (estimado)' : ''}.`,
        rows, actions: [PLAN_LINK],
      };
    }
    case 'organize': {
      if (!p || p.freeMinor === null) return answer({ k: 'free' }, v);
      const rows = p.lines.filter((l) => l.amountMinor !== null).slice(0, 7).map((l) => ({ label: `${l.label}${l.kind === 'overdue' ? ' (vencido)' : ''}`, value: `${money(l.amountMinor!, p.currency)}${l.date ? ` · ${dm(l.date)}` : ''}` }));
      rows.push({ label: p.freeMinor >= 0 ? 'Libre' : 'Faltan', value: money(Math.abs(p.freeMinor), p.currency) });
      const pending = p.lines.filter((l) => l.amountMinor === null).length;
      return {
        title: p.until ? `Hasta el ${dm(p.until)}` : 'Tu plan', text: `Así va tu dinero hasta tu próximo ingreso${p.status !== 'confirmed' ? ' (estimado)' : ''}:`,
        rows: pending ? [...rows, { label: 'Por confirmar', value: `${pending} monto${pending > 1 ? 's' : ''}` }] : rows,
        actions: [...(p.status !== 'incomplete' ? [applyAct(p)] : []), { type: 'reply', label: '¿Qué pago primero?' }, PLAN_LINK],
      };
    }
    case 'pay_min': {
      const input = v.inputs?.PEN;
      const card = (v.debtLinks ?? []).find((d) => d.currency === 'PEN' && (d.obligationId || /tarjeta|visa|mastercard|amex/i.test(d.name)));
      if (!card) return { text: '¿De qué tarjeta? No tengo una deuda de tarjeta registrada.', actions: [{ type: 'link', label: 'Agregar deuda', href: '/app/compromisos' }] };
      if (!input?.base) return { text: 'Para responderte necesito saber cuánto tienes disponible hoy. ¿Cuánto es?', pending: 'balance' };
      // With a statement on file, "total" is what was billed (post-cut purchases go to the next statement).
      const st = (v.cards ?? []).find((c) => c.currency === 'PEN' && c.position?.billed?.amountMinor != null)?.position ?? null;
      if (st?.billed && st.billed.amountMinor !== null) {
        const billed = st.billed.amountMinor;
        // Free after paying the billed total = free + what the plan already reserved for this card − billed.
        const pen = v.plans.find((x) => x.currency === 'PEN');
        const reservedForCard = pen?.lines.filter((l) => card.obligationId && l.obligationId === card.obligationId).reduce((s2, l) => s2 + (l.amountMinor ?? 0), 0) ?? 0;
        const after = pen?.freeMinor == null ? null : pen.freeMinor + reservedForCard - billed;
        const due = dm(st.billed.dueDate);
        if (after !== null && after >= 0) return { text: `Paga el total facturado (${money(billed, 'PEN')}) hasta el ${due}: te quedan ${money(after, 'PEN')} libres y no pagas intereses.`, actions: [PLAN_LINK] };
        const carried = st.minimumOnly ? ` Pasan ${money(st.minimumOnly.carriedMinor, 'PEN')} al próximo ciclo${st.minimumOnly.interestMinor ? `, ~${money(st.minimumOnly.interestMinor, 'PEN')} de interés` : ' con interés'}.` : '';
        return { text: `No te alcanza para el total (${money(billed, 'PEN')}). Paga al menos el mínimo${st.billed.minimumMinor !== null ? ` (${money(st.billed.minimumMinor, 'PEN')})` : ''} hasta el ${due} y abona lo que puedas.${carried}`, actions: [PLAN_LINK] };
      }
      const total = payDebt(input, card, card.balanceMinor)!;
      const min = v.obligations.find((o) => o.id === card.obligationId)?.amountMinor ?? null;
      if (total.freeAfterMinor !== null && total.freeAfterMinor >= 0) {
        return { text: `Paga el total (${money(card.balanceMinor, 'PEN')}): te quedan ${money(total.freeAfterMinor, 'PEN')} libres y no pagas intereses.`, actions: [PLAN_LINK] };
      }
      return { text: `Con el total te faltarían ${money(-(total.freeAfterMinor ?? 0), 'PEN')}. Paga${min ? ` al menos el mínimo (${money(min, 'PEN')})` : ' al menos el mínimo'} y abona lo que puedas.`,
        actions: [{ type: 'reply', label: `¿Qué pasa si pago S/ ${Math.round(Math.max(0, (p?.freeMinor ?? 0)) / 100)} a la tarjeta?` }, PLAN_LINK] };
    }
    case 'owe':
      return { text: `¿Lo guardo como deuda con ${intent.lender}: ${money(intent.amountMinor, intent.currency)}? Queda pendiente, no pagada.`,
        actions: [{ type: 'act', label: 'Guardar', act: 'create_debt', fields: { lender: intent.lender.slice(0, 40), amount: String(intent.amountMinor), currency: intent.currency } }] };
    case 'apply_plan': {
      if (!p || p.freeMinor === null || p.status === 'incomplete' || !p.until) return { text: (p && missingText(p)) ?? 'Para aplicar un plan necesito tu saldo y tu próximo ingreso.', actions: [PLAN_LINK] };
      return {
        title: `Plan hasta el ${dm(p.until)}`,
        text: `¿Lo aplico? Aparta ${money(p.reservedMinor, p.currency)} en pagos y reservas${p.status !== 'confirmed' ? ' (estimado)' : ''}. No paga ni mueve dinero.`,
        rows: [{ label: p.freeMinor >= 0 ? 'Te queda libre' : 'Faltan', value: money(Math.abs(p.freeMinor), p.currency) }],
        actions: [applyAct(p), PLAN_LINK],
      };
    }
    case 'estimate_basics':
      return { text: `¿Uso ${money(intent.amountMinor, 'PEN')} al mes para lo básico? Queda como estimado.`,
        actions: [{ type: 'act', label: 'Usar', act: 'set_essentials', fields: { amount: String(intent.amountMinor) } }] };
    case 'help':
      return { text: 'Puedo decirte cuánto tienes libre, qué pagos vienen, si te alcanza para una compra o qué pagar primero.', actions: [{ type: 'reply', label: '¿Cuánto tengo libre?' }, { type: 'reply', label: '¿Qué viene esta semana?' }] };
    default:
      return null;
  }
}

/** "te quedan S/ 850 libres (antes S/ 1,350)" — brief, with the currency and the estimate flag. */
function freeText(r: ScenarioResult): string {
  if (r.freeAfterMinor === null) return 'no puedo calcularlo aún.';
  const est = r.estimated ? ' (estimado)' : '';
  const before = r.freeBeforeMinor === null ? '' : ` (antes ${money(r.freeBeforeMinor, r.currency)})`;
  return r.freeAfterMinor >= 0 ? `te quedan ${money(r.freeAfterMinor, r.currency)} libres${est}${before}.` : `te faltarían ${money(-r.freeAfterMinor, r.currency)}${est}${before}.`;
}

function dateAdd(d: string, n: number) { return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10); }

/** Compact, number-complete state for a provider (§23): facts computed by the engine, not the transcript. */
export function compactView(v: View): string {
  const lines: string[] = [`Hoy: ${v.today}`];
  for (const p of v.plans) {
    lines.push(`${p.currency}: saldo ${p.base ? money(p.base.amountMinor, p.currency) : 'desconocido'}; libre ${p.freeMinor === null ? 'desconocido' : money(p.freeMinor, p.currency)}${p.until ? ` hasta ${p.until}` : ''}; separado ${money(p.reservedMinor, p.currency)}`);
    for (const l of p.lines.slice(0, 8)) lines.push(`- ${l.label}: ${l.amountMinor === null ? '?' : money(l.amountMinor, p.currency)}${l.date ? ` (${l.date})` : ''}`);
    for (const m of p.missing.slice(0, 3)) lines.push(`Falta: ${m.text}`);
  }
  for (const d of v.debts.slice(0, 5)) lines.push(`Deuda ${d.name}: ${money(d.balanceMinor, d.currency)}${d.annualRateBp !== null ? `, ${d.annualRateBp / 100}% anual` : ''}`);
  if (v.reviewCount) lines.push(`Movimientos por revisar: ${v.reviewCount}`);
  return lines.join('\n').slice(0, 2500);
}

/**
 * Up to 3 openers when Vels opens, from real state first, then from the screen the person is on (ADR-0011).
 * Only questions Vels answers deterministically; nothing here writes.
 */
export function velsSuggestions(v: View, path: string): string[] {
  const out: string[] = [];
  const add = (q: string | null) => { if (q && !out.includes(q) && out.length < 3) out.push(q); };
  const p = primary(v);
  if (v.incomeMatches?.length) add('Ya me pagaron');
  else if (v.recentIncome && daysFrom(v.today, v.recentIncome.date) <= 3) add('Organiza mi dinero');
  const soon = (v.timeline ?? []).find((t) => t.kind !== 'income' && t.date !== null && !t.overdue && daysFrom(t.date, v.today) <= 7 && /tarjeta|visa|amex|mastercard/i.test(t.label));
  if (soon) add('¿Pago el mínimo?');
  if (path.startsWith('/app/plan') && p?.freeMinor != null) add(`¿Por qué tengo ${money(Math.max(0, p.freeMinor), p.currency)} libres?`);
  if (path.startsWith('/app/compromisos')) add('¿Qué pago primero?');
  if (path.startsWith('/app/tarjetas')) add('¿Hasta cuánto puedo usar la tarjeta?');
  if (path.startsWith('/app/movimientos') || path.startsWith('/app/analisis')) add('¿Qué cambió este mes?');
  const before = p ? p.lines.filter((l) => l.kind === 'payment' || l.kind === 'overdue' || l.kind === 'debt').length : 0;
  if (before >= 3) add('Organiza mis pagos');
  add('¿Cuánto tengo libre?');
  add('¿Puedo gastar S/ 300?');
  return out;
}
const daysFrom = (later: string, earlier: string) => Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);
