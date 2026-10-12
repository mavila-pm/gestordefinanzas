-- Fix for 029 (verified on the real project): an account created by the email link already has a random password
-- set by Supabase Auth, so "has a password" cannot prove the person created one, and mark_password_set() could be
-- called from the browser to skip the step. The password step is now recorded only when Supabase Auth actually
-- changes the password (trigger on auth.users), and the client-callable function can no longer be executed.
create or replace function public.on_auth_password_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.encrypted_password is distinct from old.encrypted_password and coalesce(new.encrypted_password, '') <> '' then
    insert into public.profiles (user_id, password_set_at) values (new.id, now())
      on conflict (user_id) do update set password_set_at = coalesce(public.profiles.password_set_at, now()), updated_at = now();
  end if;
  return new;
end $$;
revoke all on function public.on_auth_password_changed() from public, anon, authenticated;

create trigger on_auth_password_changed after update of encrypted_password on auth.users
  for each row execute function public.on_auth_password_changed();

revoke execute on function public.mark_password_set() from public, anon, authenticated;
