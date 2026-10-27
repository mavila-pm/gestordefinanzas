import Link from 'next/link';
import { ActionForm } from '../../../components/action-form';
import { Sheet } from '../../../components/ui/sheet';
import { createSupabaseServerClient } from '../../../lib/supabase/server';
import { loadBudgets, loadCommitmentData } from '../../../lib/queries';
import { loadPlanningData } from '../../../lib/planning';
import { loadInvestments } from '../../../lib/investments';
import { formatMoney, type Currency } from '../../../src/domain/money';
import { budgetStatus } from '../../../src/engine/budgets';
import { financialBalance, type Goal } from '../../../src/engine/financial-balance';
import { rowToTransaction, TRANSACTION_SELECT, type TransactionRow } from '../../../src/infrastructure/supabase/transaction-row';
import { limaMonth, limaMonthRange } from '../../../src/web/auth-input';
import { saveGoalAction } from './actions';

export const metadata = { title: 'Balance financiero' };
const m = (v: number, c: Currency) => formatMoney({ amountMinor: v, currency: c });
const LINE: Record<string, { label: string; href: string; cta: string }> = {
  budgets: { label: 'Presupuesto por categoría', href: '/app/presupuestos', cta: 'Límites' },
  fixed: { label: 'Pagos fijos y membresías', href: '/app/compromisos', cta: 'Pagos' },
  debts: { label: 'Cuotas de deudas', href: '/app/deudas', cta: 'Deudas' },
  savings: { label: 'Meta de ahorro', href: '#metas', cta: '' },
  investment: { label: 'Meta de inversión', href: '#metas', cta: '' },
};
/** Categories suggested when the person has no limits yet (labels only, the person picks). */
const SUGGESTED = ['Vivienda', 'Alimentación', 'Transporte', 'Servicios', 'Educación', 'Salud', 'Ocio'];

function GoalSheet({ kind, currency, goal, investments, investmentId }: {
  kind: 'savings' | 'investment'; currency: Currency; goal: Goal | null; investments: { id: string; name: string }[]; investmentId: string | null;
}) {
  const title = kind === 'savings' ? 'Meta de ahorro' : 'Meta de inversión';
  const value = goal ? goal.mode === 'fixed' ? goal.amountMinor !== null ? (goal.amountMinor / 100).toFixed(2) : '' : goal.bp !== null ? String(goal.bp / 100) : '' : '';
  return (
    <Sheet label={goal ? 'Cambiar' : 'Definir'} triggerClassName={goal ? 'link small' : 'quiet'} title={title} triggerLabel={`${title} (${currency})`}
      subtitle="Un monto fijo al mes o un porcentaje de tus ingresos. Elige uno.">
      <div className="sheet-body">
        <ActionForm action={saveGoalAction} label={title} closeOnSuccess>
          <input type="hidden" name="kind" value={kind} /><input type="hidden" name="currency" value={currency} />
          <fieldset className="segmented bare"><legend>Cómo la defines</legend>
            <div className="segments" role="radiogroup">
              <label className="segment"><input type="radio" name="mode" value="fixed" defaultChecked={!goal || goal.mode === 'fixed'} /><span>Monto fijo</span></label>
              <label className="segment"><input type="radio" name="mode" value="percent" defaultChecked={goal?.mode === 'percent'} /><span>% de ingresos</span></label>
            </div>
          </fieldset>
          <label className="stack-sm"><span>Monto al mes o porcentaje</span><input name="value" inputMode="decimal" placeholder="500 o 10" defaultValue={value} /></label>
          {kind === 'investment' && investments.length > 0 && (
            <label className="stack-sm"><span>¿Para qué inversión? <small className="muted">(opcional)</small></span>
              <select name="investmentId" defaultValue={investmentId ?? ''}><option value="">Ninguna en particular</option>{investments.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></label>
          )}
          <small className="muted">Déjalo vacío para quitar la meta. Es un plan: solo el dinero que de verdad muevas cuenta.</small>
          <button type="submit" className="wide">Guardar</button>
        </ActionForm>
      </div>
    </Sheet>
  );
}

/**
 * Balance financiero (UX audit §2.3, CR-002): the person's monthly plan per currency — expected income (estimado) and
 * how it is assigned: limits per category, fixed payments and memberships, debt installments, savings and investment
 * goals (fixed or % of income). What is left is "sin asignar"; a negative is said plainly. Pure engine:
 * src/engine/financial-balance.ts. Nothing here moves money.
 */
export default async function Balance() {
  const supabase = await createSupabaseServerClient();
  const month = limaMonth();
  const range = limaMonthRange(month)!;
  const [planning, budgets, { fixed, debts }, investments, txRes] = await Promise.all([
    loadPlanningData(supabase), loadBudgets(supabase), loadCommitmentData(supabase), loadInvestments(supabase),
    supabase.from('transactions').select(TRANSACTION_SELECT).gte('occurred_at', range.from).lt('occurred_at', range.to).limit(3000),
  ]);
  const status = budgetStatus(((txRes.data ?? []) as unknown as TransactionRow[]).map(rowToTransaction), month, budgets);
  const currencies = (['PEN', 'USD'] as Currency[]).filter((c) => c === 'PEN' || planning.incomes.some((i) => i.currency === c) || budgets.some((b) => b.currency === c));

  return (
    <main className="stack">
      <div className="page-head"><h1>Balance financiero</h1><p>Cómo repartes tus ingresos del mes: presupuesto, pagos, deudas, ahorro e inversión.</p></div>
      {currencies.map((c) => {
        const s = planning.settings[c];
        const b = financialBalance({
          currency: c,
          incomes: planning.incomes.map((i) => ({ currency: i.currency, amountMinor: i.amountMinor, frequency: i.frequency })),
          budgets: budgets.map((x) => ({ currency: x.currency, amountMinor: x.amountMinor })),
          fixed: fixed.filter((f) => f.active && !f.endedOn).map((f) => ({ currency: f.currency as Currency, amountMinor: f.amountMinor, frequency: f.frequency })),
          debts: debts.filter((d) => d.active).map((d) => ({ currency: d.currency as Currency, installmentMinor: d.installmentMinor, balanceMinor: d.balanceMinor })),
          savings: s?.savingsGoal ?? null, investment: s?.investmentGoal ?? null,
        });
        const goalNote = (g: Goal | null | undefined) => (g?.mode === 'percent' && g.bp !== null ? ` · ${g.bp / 100}% de tus ingresos` : '');
        return (
          <section key={c} className="stack-sm" aria-label={`Balance en ${c === 'USD' ? 'dólares' : 'soles'}`} data-testid={`balance-${c}`}>
            <section className="card stack-sm">
              <span className="muted small">Ingresos del mes{c === 'USD' ? ' en dólares' : ''} <small>(estimado)</small></span>
              <strong className="liq-figure">{b.incomeMinor === null ? 'Sin dato' : m(b.incomeMinor, c)}</strong>
              {b.incomeMinor === null && <p className="muted small">Agrega tus ingresos fijos en <Link href="/app/ingresos">Ingresos</Link> para repartirlos.</p>}
              {b.incomeUnknown > 0 && <small className="muted">{b.incomeUnknown === 1 ? 'Un ingreso no tiene monto aún.' : `${b.incomeUnknown} ingresos no tienen monto aún.`}</small>}
              <div>
                {b.lines.map((l) => (
                  <div key={l.key} className="balance-row">
                    <span className="setting-text"><strong>{LINE[l.key]!.label}</strong>
                      <small className="muted">{l.key === 'savings' ? goalNote(s?.savingsGoal) : l.key === 'investment' ? goalNote(s?.investmentGoal) : ''}{l.unknownCount ? `${l.unknownCount === 1 ? ' 1 sin monto' : ` ${l.unknownCount} sin monto`}` : ''}</small></span>
                    <span className="bal-right"><span className="amount">{l.amountMinor === null ? 'Sin definir' : m(l.amountMinor, c)}</span>
                      {LINE[l.key]!.cta && <Link href={LINE[l.key]!.href} className="small">{LINE[l.key]!.cta}</Link>}</span>
                  </div>
                ))}
                <div className="balance-row"><strong>Sin asignar</strong>
                  <span className={`amount${b.unassignedMinor !== null && b.unassignedMinor < 0 ? ' error' : ''}`}>{b.unassignedMinor === null ? 'Sin dato' : b.unassignedMinor < 0 ? `Te faltan ${m(-b.unassignedMinor, c)}` : m(b.unassignedMinor, c)}</span></div>
              </div>
            </section>

            <section className="card stack-sm" id="metas" aria-label="Metas">
              <h2>Metas{c === 'USD' ? ' en dólares' : ''}</h2>
              <div className="balance-row"><span className="setting-text"><strong>Ahorro</strong><small className="muted">{s?.savingsGoal ? `${s.savingsGoal.mode === 'fixed' ? 'Monto fijo' : 'Porcentaje'}${goalNote(s.savingsGoal)}` : 'Sin meta'}</small></span>
                <span className="bal-right"><span className="amount">{s?.savingsGoalMinor != null ? m(s.savingsGoalMinor, c) : '—'}</span><GoalSheet kind="savings" currency={c} goal={s?.savingsGoal ?? null} investments={[]} investmentId={null} /></span></div>
              <div className="balance-row"><span className="setting-text"><strong>Inversión</strong><small className="muted">{s?.investmentGoal ? `${s.investmentGoal.mode === 'fixed' ? 'Monto fijo' : 'Porcentaje'}${goalNote(s.investmentGoal)}${s.investmentGoalId ? ` · ${investments.find((i) => i.id === s.investmentGoalId)?.name ?? ''}` : ''}` : 'Sin meta'}</small></span>
                <span className="bal-right"><span className="amount">{b.lines.find((l) => l.key === 'investment')?.amountMinor != null ? m(b.lines.find((l) => l.key === 'investment')!.amountMinor!, c) : '—'}</span>
                  <GoalSheet kind="investment" currency={c} goal={s?.investmentGoal ?? null} investments={investments.filter((i) => i.currency === c).map((i) => ({ id: i.id, name: i.name }))} investmentId={s?.investmentGoalId ?? null} /></span></div>
              {investments.length === 0 && <small className="muted">Para apuntar tu meta a una inversión, agrégala en <Link href="/app/inversiones">Inversiones</Link>.</small>}
            </section>
          </section>
        );
      })}

      <section className="card stack-sm" aria-labelledby="h-cats">
        <div className="row"><h2 id="h-cats">Presupuesto por categoría</h2><Link href="/app/presupuestos" className="quiet">Editar límites</Link></div>
        {status.length === 0 ? (
          <p className="muted small">Pon un límite mensual a tus categorías principales, por ejemplo: {SUGGESTED.join(', ')}. Puedes crear las tuyas (Gym, Auto…) en Movimientos.</p>
        ) : status.map((x) => (
          <div key={`${x.category}|${x.currency}`} className="balance-row">
            <span className="setting-text"><strong>{x.category}</strong><small className={x.state === 'exceeded' ? 'error' : 'muted'}>{m(Math.abs(x.spentMinor), x.currency)} de {m(x.amountMinor, x.currency)}</small></span>
            <span className="amount">{Math.round(x.ratio * 100)}%</span>
          </div>
        ))}
      </section>
    </main>
  );
}
