-- Cap (anti-bot): single-use proof that a challenge and its redeem token were used once (no replay).
-- The server spends two keys per verification: the solved challenge's signature (at /api/cap/.../redeem) and the
-- redeem token id (inside the protected server action: login, signup, password recovery). Only SHA-256 hashes are
-- stored, with the expiry of what they protect; an expired key can be spent again only because its token is already
-- rejected as expired before reaching here. No DELETE: an expired row is reused in place (purge is a separate decision).
create table public.cap_spent (
  key_hash text primary key check (key_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null
);
alter table public.cap_spent enable row level security;
revoke all on public.cap_spent from public, anon, authenticated;

-- true = this key was not spent (now it is); false = already spent and still valid → the caller must refuse.
create or replace function public.cap_spend(p_key text, p_ttl_seconds integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_hash text;
begin
  if p_key is null or p_key !~ '^[a-z]:[A-Za-z0-9_-]{16,128}$' then raise exception 'invalid_request' using errcode = '22023'; end if;
  if p_ttl_seconds is null or p_ttl_seconds not between 1 and 3600 then raise exception 'invalid_request' using errcode = '22023'; end if;
  v_hash := encode(sha256(convert_to(p_key, 'UTF8')), 'hex');
  insert into public.cap_spent as s (key_hash, expires_at) values (v_hash, now() + make_interval(secs => p_ttl_seconds))
    on conflict (key_hash) do update set expires_at = excluded.expires_at where s.expires_at < now();
  return found;
end $$;

revoke all on function public.cap_spend(text, integer) from public, anon, authenticated;
-- Called by the server under the visitor's (anonymous) session: login and signup happen before there is a user.
grant execute on function public.cap_spend(text, integer) to anon, authenticated;
