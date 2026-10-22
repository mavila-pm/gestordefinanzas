-- FRONT A (auth/security audit, 2026-10-20). Two independent hardenings, no data rewritten, nothing deleted.
--
-- 1. Function EXECUTE hygiene. Trigger functions are never called directly: PostgreSQL does not check EXECUTE when a
--    trigger fires, only when CREATE TRIGGER runs. Yet card_statements_currency and plan_applications_transition kept
--    the default PUBLIC grant, so anon could call them (Supabase advisor). Every trigger function in public loses
--    EXECUTE for public, anon and authenticated. tests/db/rls.test.ts now guards function grants: anon may execute
--    only an explicit allowlist, and the SECURITY DEFINER functions authenticated can execute equal a reviewed list.
--
-- 2. complete_registration (029, 036) could be called again after completion, without limit:
--    * phone_taken told any signed-in account which +51 numbers already have a Velsuno account (enumeration oracle);
--    * the re-call could rewrite the person's own phone or birth date outside the UI (the 18+ check stays in SQL, but
--      the stored birth date and the one-number-per-account history must not change after the account is ready).
--    Replacement public.finish_registration (same arguments): refuses once registration_completed_at is set
--    ('already_registered', nothing rewritten); counts phone_taken refusals per account in a private table; after 5
--    within 24 h answers 'too_many_attempts' to every call, even with a free number. The count must survive the
--    refusal, so the function RETURNS a status text instead of raising phone_taken (a raise would roll the counter
--    back): 'ok' | 'already_registered' | 'phone_taken' | 'too_many_attempts'. Validation errors (invalid_name,
--    invalid_phone, invalid_birth_date, under_age, consent_version, password_step_pending) still raise: they reveal
--    nothing about other people. Calls of one account are serialised by a row lock on its profile, so parallel calls
--    cannot outrun the counter.
--    The old complete_registration stays in place (no DROP, like 047) but nobody can execute it any more: the
--    oracle is closed the moment this applies. Order: ship the app first (app/auth/actions.ts calls
--    finish_registration and, only while this migration is not applied, falls back to the old function); then apply.
--    Rollback: grant execute on the old function to authenticated again.

-- ── 1. Trigger functions: no direct EXECUTE ───────────────────────────────────────────────────────────────────
do $$
declare f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prorettype = 'trigger'::regtype
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  -- A revoke by a role that does not own the function only warns. Fail the whole migration instead of leaving a
  -- grant behind silently (the live project must end exactly like the local test).
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join (values ('anon'), ('authenticated')) r(role)
    where n.nspname = 'public' and p.prorettype = 'trigger'::regtype and has_function_privilege(r.role, p.oid, 'EXECUTE')
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  ) then
    raise exception 'trigger function still executable by a client role after the revoke';
  end if;
end $$;

-- ── 2. Registration: refusal counter (private) ─────────────────────────────────────────────────────────────────
-- One row per account at most (fixed 24 h window from the first refusal), written only by finish_registration
-- (SECURITY DEFINER). RLS on with no policy and no grant: deny-all for every client role, like login_throttle.
create table public.registration_phone_refusals (
  user_id uuid primary key references auth.users (id) on delete cascade,
  window_start timestamptz not null default now(),
  refusals integer not null default 0 check (refusals between 0 and 1000000)
);
alter table public.registration_phone_refusals enable row level security;
revoke all on public.registration_phone_refusals from public, anon, authenticated;

-- ── 2. Registration: replacement function; the old one is no longer executable ────────────────────────────────
-- A new name because the return type changes (void → text), which CREATE OR REPLACE cannot do, and a DROP would keep
-- this migration out of the connector (docs/runbooks/supabase-migrations.md).
revoke all on function public.complete_registration(text, text, text, date, text, text) from public, anon, authenticated;

create function public.finish_registration(p_given text, p_family text, p_phone text, p_birth date, p_terms text, p_privacy text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  today date := (now() at time zone 'America/Lima')::date;
  cur_terms text := (select d.version from public.legal_documents d where d.kind = 'terms' order by d.published_at desc limit 1);
  cur_privacy text := (select d.version from public.legal_documents d where d.kind = 'privacy' order by d.published_at desc limit 1);
  given text := btrim(p_given); family text := btrim(p_family);
  prof record;
  lim record;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  -- One call at a time per account (row lock until commit): the refusal count below cannot be raced.
  select pr.password_set_at, pr.registration_completed_at into prof from public.profiles pr where pr.user_id = uid for update;
  if not found or prof.password_set_at is null then
    raise exception 'password_step_pending' using errcode = '22023';
  end if;
  -- A finished registration is final: no second phone/birth date, and no phone lookups from a ready account.
  if prof.registration_completed_at is not null then return 'already_registered'; end if;
  select r.window_start, r.refusals into lim from public.registration_phone_refusals r where r.user_id = uid;
  if found and lim.window_start > now() - interval '24 hours' and lim.refusals >= 5 then return 'too_many_attempts'; end if;

  if given is null or char_length(given) not between 1 and 80 or given ~ '[[:cntrl:]<>]'
    or family is null or char_length(family) not between 1 and 80 or family ~ '[[:cntrl:]<>]' then
    raise exception 'invalid_name' using errcode = '22023';
  end if;
  if p_phone is null or p_phone !~ '^\+519[0-9]{8}$' then raise exception 'invalid_phone' using errcode = '22023'; end if;
  if p_birth is null or p_birth < date '1900-01-01' or p_birth > today then raise exception 'invalid_birth_date' using errcode = '22023'; end if;
  if p_birth > (today - interval '18 years')::date then raise exception 'under_age' using errcode = '22023'; end if;
  if p_terms is distinct from cur_terms or p_privacy is distinct from cur_privacy then
    raise exception 'consent_version' using errcode = '22023';
  end if;

  begin
    insert into public.legal_acceptances (user_id, kind, version) values (uid, 'terms', cur_terms), (uid, 'privacy', cur_privacy)
      on conflict (user_id, kind, version) do nothing;
    update public.profiles set given_names = given, family_names = family,
        display_name = left(split_part(given, ' ', 1), 40), phone_e164 = p_phone, birth_date = p_birth,
        registration_completed_at = now(), updated_at = now()
      where user_id = uid;
  exception when unique_violation then
    -- Only the one-number-per-account trigger (037) is answered here; any other violation is a real error.
    if sqlerrm is distinct from 'phone_taken' then raise; end if;
    -- The block above rolled back (nothing half-saved); the refusal itself is kept.
    insert into public.registration_phone_refusals as r (user_id, window_start, refusals) values (uid, now(), 1)
      on conflict (user_id) do update set
        refusals = case when r.window_start > now() - interval '24 hours' then r.refusals + 1 else 1 end,
        window_start = case when r.window_start > now() - interval '24 hours' then r.window_start else now() end;
    return 'phone_taken';
  end;
  return 'ok';
end $$;

revoke all on function public.finish_registration(text, text, text, date, text, text) from public, anon;
grant execute on function public.finish_registration(text, text, text, date, text, text) to authenticated;
