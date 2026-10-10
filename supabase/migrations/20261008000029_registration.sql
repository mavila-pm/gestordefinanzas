-- Registration (email first → verified link → password → profile → consents → account ready).
-- Identity and the email link stay in Supabase Auth (signInWithOtp + token_hash); this migration only records the
-- steps that Velsuno requires after the link, server-side and auditable:
--   * profiles: phone (E.164), birth date (adults only, checked here), password step, completion time;
--   * legal_documents / legal_acceptances: which Terms/Privacy version each person accepted, and when.
-- Accounts created before REGISTRATION_CUTOFF keep working as they are (grandfathered): only new accounts must
-- complete the steps. The client can never mark a step done by itself: those columns are not grantable.

alter table public.profiles
  add column phone_e164 text check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  add column birth_date date check (birth_date between '1900-01-01' and '2100-01-01'),
  add column password_set_at timestamptz,
  add column registration_completed_at timestamptz;

-- Column-level privileges: the person edits only their names (Ajustes); registration fields go through functions.
revoke insert, update on public.profiles from authenticated;
grant insert (user_id, given_names, family_names, display_name, updated_at) on public.profiles to authenticated;
grant update (given_names, family_names, display_name, updated_at) on public.profiles to authenticated;

-- ── Legal documents and acceptances (append-only, per version) ─────────────────────────────────────────────
create table public.legal_documents (
  kind text not null check (kind in ('terms', 'privacy')),
  version text not null check (version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  published_at timestamptz not null default now(),
  primary key (kind, version)
);
alter table public.legal_documents enable row level security;
revoke all on public.legal_documents from anon, authenticated;
grant select on public.legal_documents to authenticated;
create policy legal_documents_read on public.legal_documents for select to authenticated using (true);
insert into public.legal_documents (kind, version) values ('terms', '2026-10-08'), ('privacy', '2026-10-08');

create table public.legal_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null,
  version text not null,
  accepted_at timestamptz not null default now(),
  foreign key (kind, version) references public.legal_documents (kind, version),
  unique (user_id, kind, version)
);
alter table public.legal_acceptances enable row level security;
revoke all on public.legal_acceptances from anon, authenticated;
grant select on public.legal_acceptances to authenticated;
create policy legal_acceptances_own on public.legal_acceptances for select to authenticated using (user_id = (select auth.uid()));

-- ── Status of the signed-in person's registration ───────────────────────────────────────────────────────────
-- required: a new account (created at/after the cutoff) that has not completed the steps.
create or replace function public.my_registration()
returns table (required boolean, password_done boolean, completed boolean)
language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := auth.uid(); created timestamptz; p record;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  select u.created_at into created from auth.users u where u.id = uid;
  select pr.password_set_at, pr.registration_completed_at into p from public.profiles pr where pr.user_id = uid;
  completed := p.registration_completed_at is not null;
  password_done := p.password_set_at is not null;
  required := not completed and coalesce(created, now()) >= timestamptz '2026-10-08 05:00:00+00';
  return next;
end $$;

-- Step 2: called right after Supabase Auth accepted the new password. Refuses when the account has no password.
create or replace function public.mark_password_set()
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if not exists (select 1 from auth.users u where u.id = uid and coalesce(u.encrypted_password, '') <> '') then
    raise exception 'password_missing' using errcode = '22023';
  end if;
  insert into public.profiles (user_id, password_set_at) values (uid, now())
    on conflict (user_id) do update set password_set_at = coalesce(public.profiles.password_set_at, now()), updated_at = now();
end $$;

-- Step 3: profile + age (18+, Lima calendar) + acceptance of the CURRENT Terms and Privacy versions, atomically.
create or replace function public.complete_registration(p_given text, p_family text, p_phone text, p_birth date, p_terms text, p_privacy text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  today date := (now() at time zone 'America/Lima')::date;
  cur_terms text := (select d.version from public.legal_documents d where d.kind = 'terms' order by d.published_at desc limit 1);
  cur_privacy text := (select d.version from public.legal_documents d where d.kind = 'privacy' order by d.published_at desc limit 1);
  given text := btrim(p_given); family text := btrim(p_family);
begin
  if uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles pr where pr.user_id = uid and pr.password_set_at is not null) then
    raise exception 'password_step_pending' using errcode = '22023';
  end if;
  if given is null or char_length(given) not between 1 and 80 or given ~ '[[:cntrl:]<>]'
    or family is null or char_length(family) not between 1 and 80 or family ~ '[[:cntrl:]<>]' then
    raise exception 'invalid_name' using errcode = '22023';
  end if;
  if p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'invalid_phone' using errcode = '22023'; end if;
  if p_birth is null or p_birth < date '1900-01-01' or p_birth > today then raise exception 'invalid_birth_date' using errcode = '22023'; end if;
  if p_birth > (today - interval '18 years')::date then raise exception 'under_age' using errcode = '22023'; end if;
  if p_terms is distinct from cur_terms or p_privacy is distinct from cur_privacy then
    raise exception 'consent_version' using errcode = '22023';
  end if;

  insert into public.legal_acceptances (user_id, kind, version) values (uid, 'terms', cur_terms), (uid, 'privacy', cur_privacy)
    on conflict (user_id, kind, version) do nothing;
  update public.profiles set given_names = given, family_names = family,
      display_name = left(split_part(given, ' ', 1), 40), phone_e164 = p_phone, birth_date = p_birth,
      registration_completed_at = coalesce(registration_completed_at, now()), updated_at = now()
    where user_id = uid;
end $$;

revoke all on function public.my_registration(), public.mark_password_set(),
  public.complete_registration(text, text, text, date, text, text) from public, anon;
grant execute on function public.my_registration(), public.mark_password_set(),
  public.complete_registration(text, text, text, date, text, text) to authenticated;
