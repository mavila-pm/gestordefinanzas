-- Progressive lockout for the login form, decided and stored in the database (never in the browser).
-- Two keys per attempt: the normalized email and the client IP, stored only as SHA-256 hashes (no plaintext emails of
-- people who may not even have an account). Same behaviour for registered and unknown emails: no enumeration.
-- Every 3 attempts on an email that are not followed by a successful sign-in lock it: 5 min, then 15, then 30 (and 30 for
-- every later group). The IP key uses the same steps every 20 attempts: it stops one address from trying many emails
-- without locking out people who share a carrier IP (CGNAT is common on mobile networks in Peru). An attempt is
-- reserved BEFORE the password is checked (row lock), so parallel requests cannot get more than 3 tries per window.
-- A successful sign-in resets the person's email key and the IP key. Locks always expire; a key quiet for 24 h starts
-- again from the first step. Password recovery is not affected (it never calls these).
create table public.login_throttle (
  key_hash text primary key check (key_hash ~ '^[0-9a-f]{64}$'),
  attempts integer not null default 0 check (attempts between 0 and 20),
  stage integer not null default 0 check (stage >= 0),
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.login_throttle enable row level security;
revoke all on public.login_throttle from public, anon, authenticated;

create or replace function public.login_throttle_key(p_kind text, p_value text)
returns text language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(p_kind || ':' || lower(btrim(p_value)), 'UTF8')), 'hex')
$$;

-- Reserve one attempt for (email, ip). allowed = false: locked, wait_seconds left. allowed = true: the attempt may
-- proceed; wait_seconds > 0 when this attempt closed a group of 3 (the lock that applies if it fails).
create or replace function public.login_attempt(p_email text, p_ip text)
returns table (allowed boolean, wait_seconds integer) language plpgsql security definer set search_path = '' as $$
declare
  v_email_key text := public.login_throttle_key('email', coalesce(p_email, ''));
  v_ip_key text;
  v_keys text[] := array[v_email_key];
  v_key text; r public.login_throttle; v_wait integer := 0; v_lock integer;
begin
  if p_email is null or char_length(p_email) not between 3 and 320 then raise exception 'invalid_request' using errcode = '22023'; end if;
  if p_ip is not null and char_length(p_ip) between 1 and 64 then
    v_ip_key := public.login_throttle_key('ip', p_ip);
    v_keys := v_keys || v_ip_key;
  end if;
  v_keys := array(select unnest(v_keys) order by 1); -- fixed lock order: no deadlock between parallel requests
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
      where t.key_hash = v_key and t.attempts >= case when v_key = v_email_key then 3 else 20 end
      returning ceil(extract(epoch from t.locked_until - now()))::integer into v_lock;
    if found then v_wait := greatest(v_wait, v_lock); end if;
  end loop;
  allowed := true; wait_seconds := v_wait; return next;
end $$;

-- After a successful sign-in: clear the signed-in person's own email key (from auth.users, never a parameter) and the IP key.
create or replace function public.login_succeeded(p_ip text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_email text;
begin
  select u.email into v_email from auth.users u where u.id = auth.uid();
  if v_email is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  update public.login_throttle t set attempts = 0, stage = 0, locked_until = null, updated_at = now()
    where t.key_hash = public.login_throttle_key('email', v_email)
       or (p_ip is not null and char_length(p_ip) between 1 and 64 and t.key_hash = public.login_throttle_key('ip', p_ip));
end $$;

revoke all on function public.login_throttle_key(text, text), public.login_attempt(text, text), public.login_succeeded(text) from public, anon, authenticated;
grant execute on function public.login_attempt(text, text) to anon, authenticated;
grant execute on function public.login_succeeded(text) to authenticated;
