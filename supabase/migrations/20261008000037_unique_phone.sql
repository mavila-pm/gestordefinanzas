-- One phone number per account (PO, 2026-10-08). Emails are already unique in Supabase Auth (auth.users).
-- A plain unique index cannot be created: the live project already has duplicates (synthetic E2E accounts and two
-- real accounts sharing a number), and real data is never rewritten here. So the rule is enforced for every NEW
-- write: setting phone_e164 to a number another profile already has is refused. The transaction-scoped advisory
-- lock on the number serialises two registrations with the same number (no race). Existing duplicates stay as they
-- are until the Product Owner resolves them; the person who already has the number can keep it.
create or replace function public.profiles_phone_unique() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.phone_e164 is null or (tg_op = 'UPDATE' and new.phone_e164 is not distinct from old.phone_e164) then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('profiles.phone:' || new.phone_e164, 0));
  if exists (select 1 from public.profiles p where p.phone_e164 = new.phone_e164 and p.user_id <> new.user_id) then
    raise exception 'phone_taken' using errcode = '23505';
  end if;
  return new;
end $$;
revoke all on function public.profiles_phone_unique() from public, anon, authenticated;

create trigger profiles_phone_unique before insert or update of phone_e164 on public.profiles
  for each row execute function public.profiles_phone_unique();

-- Lookups by number stay cheap (not unique: see above).
create index if not exists profiles_phone_e164_idx on public.profiles (phone_e164) where phone_e164 is not null;
