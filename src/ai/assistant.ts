import type { Currency } from '../domain/money';
import { compareDebtStrategies, simulatePurchase, type MatchSuggestion, type Plan } from '../engine/planning';
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
  | { k: 'changed' } | { k: 'help' } | { k: 'unknown' };

const NAMES = ['carro', 'auto', 'alquiler', 'internet', 'luz', 'agua', 'gas', 'celular', 'telefono', 'tarjeta', 'seguro', 'colegio', 'universidad', 'netflix', 'spotify', 'gimnasio', 'prestamo', 'cable'];
const nameIn = (t: string) => NAMES.find((n) => new RegExp(`\\b${n}\\b`).test(t)) ?? null;

export function detectIntent(message: string): Intent {
  const t = fold(message);
  const amount = findAmounts(t)[0];
  const name = nameIn(t);
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
}
export type Action =
  | { type: 'link'; label: string; href: string }
  | { type: 'act'; label: string; act: 'patch_obligation' | 'mark_paid' | 'record_balance'; fields: Record<string, string> }
  | { type: 'reply'; label: string };
export interface Answer { text: string; rows?: Array<{ label: string; value: string }>; actions?: Action[]; pending?: 'balance' | 'income_amount' }

const dm = (d: string) => `${Number(d.slice(8, 10))} ${['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'set', 'oct', 'nov', 'dic'][Number(d.slice(5, 7)) - 1]}`;
const primary = (v: View) => v.plans.find((p) => p.base) ?? v.plans[0] ?? null;
const PLAN_LINK: Action = { type: 'link', label: 'Ver Dinero libre', href: '/app/plan' };

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
    case 'got_paid':
      return { text: '¡Bien! ¿Cuánto tienes ahora en tu cuenta? Con eso recalculo lo que tienes libre.', pending: 'balance' };
    case 'income_changed':
      return { text: 'Lo actualizo desde Dinero libre para que no cambie un ingreso por error.', actions: [{ type: 'link', label: 'Editar ingreso', href: '/app/plan' }] };
    case 'debt_paid':
      return { text: 'Buena noticia. Marca la deuda como pagada en Próximos pagos para que deje de contarse.', actions: [{ type: 'link', label: 'Ver deudas', href: '/app/compromisos' }] };
    case 'changed':
      return { text: 'La comparación con el mes anterior está en Análisis.', actions: [{ type: 'link', label: 'Ver análisis', href: '/app/analisis' }] };
    case 'help':
      return { text: 'Puedo decirte cuánto tienes libre, qué pagos vienen, si te alcanza para una compra o qué pagar primero.', actions: [{ type: 'reply', label: '¿Cuánto tengo libre?' }, { type: 'reply', label: '¿Qué viene esta semana?' }] };
    default:
      return null;
  }
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
