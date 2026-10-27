-- Login lockout fix (security review of 033): login_attempt is callable with the public key, so a caller-supplied IP
-- cannot be trusted: anyone could lock a shared carrier IP (CGNAT) for everybody behind it. The lockout now keys only on
-- the normalized email; p_ip is accepted and ignored (signature kept). Per-IP protection needs a server-only credential
-- (see docs/status.md). Unbounded growth from scripted calls is handled by a purge that the PO applies (migration 035).
create or replace function public.login_attempt(p_email text, p_ip text)
returns table (allowed boolean, wait_seconds integer) language plpgsql security definer set search_path = '' as $$
declare
  v_email_key text := public.login_throttle_key('email', coalesce(p_email, ''));
  v_keys text[] := array[v_email_key];
  v_key text; r public.login_throttle; v_wait integer := 0; v_lock integer;
begin
  if p_email is null or char_length(p_email) not between 3 and 320 then raise exception 'invalid_request' using errcode = '22023'; end if;
  foreach v_key in array v_keys loop
    insert into public.login_throttle (key_hash) values (v_key) on conflict (key_hash) do nothing;
    select * into r from public.login_throttle t where t.key_hash = v_key for update;
    if r.locked_until is not null and r.locked_until > now() then
      v_wait := greatest(v_wait, ceil(extract(epoch from r.locked_until - now()))::integer);
    end if;
  end loop;
  if v_wait > 0 then allowed := false; wait_seconds := v_wait; return next; return; end if;
  -- Allowed: count it on every key; the attempt that closes a group starts the next lock (cleared if it succeeds).
  foreach v_key in array v_keys loop
    update public.login_throttle t set
        stage = case when t.updated_at < now() - interval '24 hours' then 0 else t.stage end,
        attempts = case when t.updated_at < now() - interval '24 hours' then 1 else t.attempts + 1 end,
        updated_at = now()
      where t.key_hash = v_key;
    update public.login_throttle t set
        locked_until = now() + case t.stage when 0 then interval '5 minutes' when 1 then interval '15 minutes' else interval '30 minutes' end,
        stage = t.stage + 1, attempts = 0
      where t.key_hash = v_key and t.attempts >= 3
      returning ceil(extract(epoch from t.locked_until - now()))::integer into v_lock;
    if found then v_wait := greatest(v_wait, v_lock); end if;
  end loop;
  allowed := true; wait_seconds := v_wait; return next;
end $$;
