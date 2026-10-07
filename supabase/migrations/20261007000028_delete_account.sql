-- Account deletion (MVP P1; privacy policy "cancelación", Ley 29733). The signed-in person deletes ONLY themselves:
-- auth.uid() is the only identity input, and a typed confirmation guards against an accidental call. Every public
-- row of the person goes with the auth user through the user_id ON DELETE CASCADE foreign keys (all tables).
create or replace function public.delete_my_account(p_confirm text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if p_confirm is distinct from 'ELIMINAR' then raise exception 'confirmation required' using errcode = '22023'; end if;
  delete from auth.users where id = uid;
end $$;

revoke all on function public.delete_my_account(text) from public, anon;
grant execute on function public.delete_my_account(text) to authenticated;
