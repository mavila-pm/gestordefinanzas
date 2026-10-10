-- Security review follow-up (ADR-0012/0013/0014).
-- 1. apply_plan: a repeated reference is a replay only while that plan is still active; a stale button on a plan
--    that was removed or replaced must not report success.
create or replace function public.apply_plan(
  p_currency public.currency_code, p_base_kind text, p_base_minor bigint, p_base_transaction_id uuid,
  p_from date, p_until date, p_reserved_minor bigint, p_free_minor bigint, p_plan_status text, p_lines jsonb, p_client_ref text
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare uid uuid := auth.uid(); prev uuid; out_id uuid; st text;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text || ':plan:' || p_currency::text, 0));
  if p_client_ref is not null then
    select id, status into out_id, st from public.plan_applications where user_id = uid and client_ref = p_client_ref;
    if out_id is not null then
      if st <> 'active' then raise exception 'plan_closed' using errcode = 'P0001'; end if;
      return out_id;
    end if;
  end if;
  update public.plan_applications set status = 'superseded', closed_at = now()
    where user_id = uid and currency = p_currency and status = 'active' returning id into prev;
  insert into public.plan_applications (user_id, currency, base_kind, base_minor, base_transaction_id, from_date, until_date,
    reserved_minor, free_minor, plan_status, lines, client_ref, supersedes_id)
  values (uid, p_currency, p_base_kind, p_base_minor, p_base_transaction_id, p_from, p_until,
    p_reserved_minor, p_free_minor, p_plan_status, p_lines, p_client_ref, prev)
  returning id into out_id;
  return out_id;
end $$;

-- 2. card_statements: the person corrects amounts and dates; provenance (source/status/created_at/ref) and the card
--    a statement belongs to are not rewritable.
revoke update on public.card_statements from authenticated;
grant update (due_date, billed_minor, minimum_minor, used_minor, used_as_of, updated_at) on public.card_statements to authenticated;
