-- TASK-009: Email Bridge foundation (spec §6, §35, §36 email_connections / sync runs).
-- A private, unguessable forwarding address per user; inbound deliveries recorded for replay protection.
-- The provider-specific webhook (Postmark, Mailgun, ...) is NOT chosen yet: see docs/architecture/email-bridge.md.

create table public.email_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Local part of the private address: 'f_' + 24 random base32 chars (120 bits). Never derived from user data.
  address_local text not null unique check (address_local ~ '^f_[a-z2-7]{24}$'),
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (id, user_id)
);
create unique index email_connections_one_active on public.email_connections (user_id) where status = 'active';
create index email_connections_user on public.email_connections (user_id);
alter table public.email_connections enable row level security;

-- Server-only ledger of webhook deliveries: replay protection and diagnostics. No client access at all.
create table public.inbound_deliveries (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z0-9_]{2,30}$'),
  delivery_id text not null check (char_length(delivery_id) between 1 and 200),
  user_id uuid references auth.users (id) on delete cascade,
  outcome text not null check (outcome in ('received', 'unknown_address', 'invalid_payload', 'rate_limited', 'processed')),
  received_at timestamptz not null default now(),
  unique (provider, delivery_id)
);
create index inbound_deliveries_user_time on public.inbound_deliveries (user_id, received_at desc) where user_id is not null;
alter table public.inbound_deliveries enable row level security;

revoke all on public.email_connections, public.inbound_deliveries from anon, authenticated;
grant select on public.email_connections to authenticated;
create policy email_connections_read on public.email_connections for select to authenticated
  using (user_id = (select auth.uid()));
grant all on public.email_connections, public.inbound_deliveries to service_role;

-- Address creation/rotation happens only here: the random part is generated server-side, never chosen by the client.
grant select, insert, update on public.email_connections to app_writer;
create policy email_connections_writer on public.email_connections for all to app_writer
  using (user_id = (select public.request_uid())) with check (user_id = (select public.request_uid()));

create function public.rotate_email_connection() returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.request_uid();
  v_local text;
  v_alphabet constant text := 'abcdefghijklmnopqrstuvwxyz234567';
  -- 24 fully random bytes from two v4 UUIDs (bytes 6 and 8 carry version/variant bits and are skipped);
  -- each byte % 32 is uniform (256 = 8 * 32): 24 chars x 5 bits = 120 bits of entropy.
  v_bytes bytea := uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid());
  v_pick constant int[] := array[0,1,2,3,4,5,7,9,10,11,12,13, 16,17,18,19,20,21,23,25,26,27,28,29];
  i int;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  v_local := 'f_';
  foreach i in array v_pick loop
    v_local := v_local || substr(v_alphabet, (get_byte(v_bytes, i) % 32) + 1, 1);
  end loop;
  update public.email_connections set status = 'revoked', revoked_at = now() where user_id = v_uid and status = 'active';
  insert into public.email_connections (user_id, address_local) values (v_uid, v_local);
  return v_local;
end $$;

grant create on schema public to app_writer;
alter function public.rotate_email_connection() owner to app_writer;
revoke create on schema public from app_writer;
revoke execute on function public.rotate_email_connection() from public, anon;
grant execute on function public.rotate_email_connection() to authenticated;
