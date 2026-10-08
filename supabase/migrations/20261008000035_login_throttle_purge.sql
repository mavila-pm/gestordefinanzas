-- Bounded size for login_throttle (security review of 033): login_attempt is callable with the public key, so scripted
-- calls with random emails would add rows forever. About 1 in 100 inserts removes rows that are no longer useful:
-- quiet for 24 h (their counters would restart anyway) and not locked. Active counters and locks are never touched.
-- Contains a DELETE statement: the PO applies it in the Supabase SQL Editor (the MCP connector cannot run it).
create or replace function public.login_throttle_purge_now()
returns void language sql security definer set search_path = '' as $$
  delete from public.login_throttle t
    where t.updated_at < now() - interval '24 hours' and (t.locked_until is null or t.locked_until < now());
$$;

create or replace function public.login_throttle_purge()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.login_throttle_purge_now();
  return null;
end $$;
revoke all on function public.login_throttle_purge_now(), public.login_throttle_purge() from public, anon, authenticated;

create trigger login_throttle_purge after insert on public.login_throttle
  for each statement when (random() < 0.01) execute function public.login_throttle_purge();
