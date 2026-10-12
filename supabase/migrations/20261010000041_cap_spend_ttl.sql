-- Cap replay store (040): the app never needs a key longer than the redeem token (10 min), so cap_spend accepts at
-- most 600 s. Narrows what an anonymous caller can reserve; same signature, grants unchanged.
create or replace function public.cap_spend(p_key text, p_ttl_seconds integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_hash text;
begin
  if p_key is null or p_key !~ '^[a-z]:[A-Za-z0-9_-]{16,128}$' then raise exception 'invalid_request' using errcode = '22023'; end if;
  if p_ttl_seconds is null or p_ttl_seconds not between 1 and 600 then raise exception 'invalid_request' using errcode = '22023'; end if;
  v_hash := encode(sha256(convert_to(p_key, 'UTF8')), 'hex');
  insert into public.cap_spent as s (key_hash, expires_at) values (v_hash, now() + make_interval(secs => p_ttl_seconds))
    on conflict (key_hash) do update set expires_at = excluded.expires_at where s.expires_at < now();
  return found;
end $$;
