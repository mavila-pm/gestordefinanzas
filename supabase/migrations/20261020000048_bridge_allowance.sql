-- Spec §81 hardening of migration 032 (Free plan limits for automatic movements). Counting rules are UNCHANGED.
-- 1) ONE per-person lock for EVERY automatic write path: the lock now lives inside assert_auto_allowance, so the import
--    RPC (import_insert_transaction) and the Email Bridge (PgTransactionRepository.insert) serialize against each other
--    and against themselves. Before, only bridge-vs-bridge was serialized: two parallel imports (or an import and a
--    delivery) could both pass the check on snapshots that missed each other and go past the monthly limit or automate
--    two banks.
-- 2) VOLATILE (was STABLE): a STABLE function reuses the caller's snapshot, taken BEFORE the lock, so it would still
--    miss a row committed by the transaction it waited for. VOLATILE takes a fresh snapshot per statement, after the
--    lock (READ COMMITTED). Every read (plan, config, counts) happens after the lock.
-- 3) Fail closed: the function runs as app_writer, whose RLS is keyed on request_uid(). A caller identity that does not
--    name p_uid would count 0 rows and never limit anything, so it is refused (42501 allowance_identity_mismatch).
--    Both callers already set it: import_insert_transaction passes request_uid() itself; the bridge sets the
--    transaction-local claim for the delivery's owner.
-- The lock is transaction-scoped (released at commit/rollback) and re-entrant (the bridge also takes it before calling).
create or replace function public.assert_auto_allowance(p_uid uuid, p_institution text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  v_plan text;
  v_month_start timestamptz;
  v_limit integer;
  v_inst_limit integer;
  v_used integer;
  v_insts text[];
begin
  if p_uid is null or public.request_uid() is distinct from p_uid then
    raise exception 'allowance_identity_mismatch' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('auto_allowance:' || p_uid::text, 0));

  v_plan := public.ai_effective_plan(p_uid);
  if v_plan <> 'free' then return; end if;
  v_month_start := date_trunc('month', now() at time zone 'America/Lima') at time zone 'America/Lima';
  v_limit := coalesce((select c.value from public.plan_config c where c.key = 'free_auto_movements_per_month'), 50);
  v_inst_limit := coalesce((select c.value from public.plan_config c where c.key = 'free_institutions'), 1);

  select count(distinct t.id) into v_used from public.transactions t
    join public.transaction_sources s on s.transaction_id = t.id and s.user_id = t.user_id
    where t.user_id = p_uid and s.channel <> 'manual' and t.created_at >= v_month_start;
  if v_used >= v_limit then raise exception 'plan_auto_limit' using errcode = '53400'; end if;

  if p_institution is not null then
    select coalesce(array_agg(distinct t.institution_code), '{}') into v_insts from public.transactions t
      join public.transaction_sources s on s.transaction_id = t.id and s.user_id = t.user_id
      where t.user_id = p_uid and s.channel <> 'manual' and t.institution_code is not null;
    if not (p_institution = any (v_insts)) and coalesce(array_length(v_insts, 1), 0) >= v_inst_limit then
      raise exception 'plan_institution_limit' using errcode = '53400';
    end if;
  end if;
end $$;

grant create on schema public to app_writer;
alter function public.assert_auto_allowance(uuid, text) owner to app_writer;
revoke create on schema public from app_writer;
revoke execute on function public.assert_auto_allowance(uuid, text) from public, anon, authenticated;
