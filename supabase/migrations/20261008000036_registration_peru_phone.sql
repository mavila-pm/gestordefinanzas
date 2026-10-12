-- Registration is Peru-only (PO, 2026-10-08): the phone must be a Peruvian mobile, +51 followed by 9 digits starting
-- with 9. Same function as migration 029 otherwise (18+ on the exact Lima day, current legal versions). Existing
-- profiles are not touched; the column check stays the generic E.164 one.
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
  if p_phone is null or p_phone !~ '^\+519[0-9]{8}$' then raise exception 'invalid_phone' using errcode = '22023'; end if;
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
