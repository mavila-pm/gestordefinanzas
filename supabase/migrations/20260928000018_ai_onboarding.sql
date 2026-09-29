-- ADR-0006: conversational onboarding + assistant + camera, provider-independent AI entitlements and usage accounting.
-- * Limits live in plan_config (server-side, PROPUESTO/configurable), never in the UI.
-- * Usage is aggregated per user/bucket/day; ai_calls keeps one metric row per provider call and NEVER the prompt.
-- * Clients can read their own usage; they cannot write it. Reservation/recording go through SECURITY DEFINER
--   functions owned by app_writer (RLS still applies); the global budget guard is invisible to clients.
-- * Onboarding state holds the structured draft (facts), not a transcript; messages are short, sanitized and deletable.

insert into public.plan_config (key, value, note) values
  ('ai_onboarding_tokens', 80000, 'PROPUESTO adenda §34: one-time onboarding allowance, weighted tokens'),
  ('ai_onboarding_camera_reads', 3, 'PROPUESTO §34/§52'),
  ('ai_free_monthly_tokens', 25000, 'PROPUESTO §35'),
  ('ai_free_monthly_camera_reads', 2, 'PROPUESTO §35'),
  ('ai_trial_tokens', 300000, 'PROPUESTO §36/§80: per trial'),
  ('ai_trial_camera_reads', 15, 'PROPUESTO §36/§80'),
  ('ai_plus_monthly_tokens', 1500000, 'PROPUESTO §37: no rollover'),
  ('ai_plus_monthly_camera_reads', 50, 'PROPUESTO §37/§53'),
  ('ai_free_daily_requests', 40, '§46 rate limit (inference calls per day)'),
  ('ai_plus_daily_requests', 300, '§46'),
  ('ai_free_daily_camera_reads', 3, '§46/§53'),
  ('ai_plus_daily_camera_reads', 20, '§53'),
  ('ai_max_images_per_read', 3, '§43 small explicit batch'),
  ('ai_user_daily_budget_micro_usd', 200000, '§45 per-user fail-safe (USD 0.20/day)'),
  ('ai_global_daily_budget_micro_usd', 5000000, '§45 global_ai_budget_guard (USD 5/day)'),
  ('ai_weight_output_pct', 400, '§33 weighted tokens: output weighs 4x input'),
  ('ai_weight_cached_pct', 10, '§33 cached input weighs 0.1x'),
  ('ai_weight_image_pct', 100, '§33 image tokens weigh 1x');

-- ── Onboarding state: structured draft + what was applied (so a demo reset can remove exactly that) ──────
create table public.onboarding_states (
  user_id uuid primary key references auth.users (id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'completed', 'skipped')),
  is_demo boolean not null default false,
  facts jsonb not null default '{}' check (jsonb_typeof(facts) = 'object' and pg_column_size(facts) <= 32000),
  applied jsonb not null default '{}' check (jsonb_typeof(applied) = 'object' and pg_column_size(applied) <= 16000),
  summary text check (char_length(summary) <= 1000),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);
create trigger onboarding_states_touch before update on public.onboarding_states for each row execute function public.touch_updated_at();
-- Everyone who already uses the product keeps using it: only new accounts start in the conversation.
insert into public.onboarding_states (user_id, status, completed_at) select id, 'completed', now() from auth.users;

-- Short visible conversation (onboarding and the assistant). Never the memory of the system: facts are.
create table public.conversation_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  thread text not null check (thread in ('onboarding', 'assistant')),
  role text not null check (role in ('user', 'velsuno')),
  body text not null check (char_length(body) <= 2000),
  card jsonb check (card is null or pg_column_size(card) <= 8000),
  created_at timestamptz not null default clock_timestamp(),
  unique (id, user_id)
);
create index conversation_messages_thread on public.conversation_messages (user_id, thread, created_at);

-- ── Usage accounting (§32, §44): aggregated, provider-independent ─────────────────────────────────────
create table public.ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  bucket text not null check (bucket ~ '^(onboarding|trial|m:\d{4}-(0[1-9]|1[0-2]))$'),
  weighted_tokens bigint not null default 0 check (weighted_tokens >= 0),
  text_input_tokens bigint not null default 0 check (text_input_tokens >= 0),
  text_output_tokens bigint not null default 0 check (text_output_tokens >= 0),
  vision_input_tokens bigint not null default 0 check (vision_input_tokens >= 0),
  cached_input_tokens bigint not null default 0 check (cached_input_tokens >= 0),
  requests integer not null default 0 check (requests >= 0),
  camera_reads integer not null default 0 check (camera_reads >= 0),
  errors integer not null default 0 check (errors >= 0),
  est_cost_micro_usd bigint not null default 0 check (est_cost_micro_usd >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, bucket)
);
create table public.ai_usage_daily (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  requests integer not null default 0 check (requests >= 0),
  camera_reads integer not null default 0 check (camera_reads >= 0),
  est_cost_micro_usd bigint not null default 0 check (est_cost_micro_usd >= 0),
  primary key (user_id, day)
);
-- One metric row per provider call (§82 internal cost view: cost by model/provider, error/retry rate, P50/P90).
create table public.ai_calls (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  bucket text not null,
  operation text not null check (operation ~ '^[a-z_]{3,40}$'),
  provider text check (provider ~ '^[a-z0-9_]{2,30}$'),
  model text check (char_length(model) <= 80),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cached_tokens integer not null default 0 check (cached_tokens >= 0),
  image_tokens integer not null default 0 check (image_tokens >= 0),
  images smallint not null default 0 check (images >= 0),
  camera boolean not null default false,
  est_cost_micro_usd integer not null default 0 check (est_cost_micro_usd >= 0),
  latency_ms integer check (latency_ms >= 0),
  attempt smallint not null default 1 check (attempt between 1 and 3),
  outcome text not null default 'pending' check (outcome in ('pending', 'ok', 'error', 'invalid_output', 'timeout')),
  unique (id, user_id)
);
create index ai_calls_user on public.ai_calls (user_id, created_at);
create table public.ai_global_daily (
  day date primary key,
  requests integer not null default 0,
  est_cost_micro_usd bigint not null default 0
);

-- ── Demo/QA (§76-78): allowlisted accounts may simulate a plan for AI limits and reset their demo onboarding.
-- Rows are added by an operator (SQL), never by the client. The real subscription is never touched.
create table public.demo_access (
  user_id uuid primary key references auth.users (id) on delete cascade,
  simulated_plan text check (simulated_plan in ('free', 'trial', 'plus')),
  created_at timestamptz not null default now()
);

-- ── RLS ────────────────────────────────────────────────────────────────────────────────────────────────
alter table public.onboarding_states enable row level security;
alter table public.conversation_messages enable row level security;
alter table public.ai_usage enable row level security;
alter table public.ai_usage_daily enable row level security;
alter table public.ai_calls enable row level security;
alter table public.ai_global_daily enable row level security;
alter table public.demo_access enable row level security;
revoke all on public.onboarding_states, public.conversation_messages, public.ai_usage, public.ai_usage_daily,
  public.ai_calls, public.ai_global_daily, public.demo_access from anon, authenticated;
grant select, insert, update on public.onboarding_states to authenticated;
grant select, insert, delete on public.conversation_messages to authenticated;
grant select on public.ai_usage, public.ai_usage_daily, public.demo_access to authenticated;
grant all on public.onboarding_states, public.conversation_messages, public.ai_usage, public.ai_usage_daily,
  public.ai_calls, public.ai_global_daily, public.demo_access to service_role;
create policy onboarding_states_own on public.onboarding_states for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy conversation_messages_own on public.conversation_messages for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy ai_usage_read on public.ai_usage for select to authenticated using (user_id = (select auth.uid()));
create policy ai_usage_daily_read on public.ai_usage_daily for select to authenticated using (user_id = (select auth.uid()));
create policy demo_access_read on public.demo_access for select to authenticated using (user_id = (select auth.uid()));

grant select, insert, update on public.ai_usage, public.ai_usage_daily, public.ai_global_daily to app_writer;
grant select, insert, update on public.ai_calls to app_writer;
grant select, update on public.demo_access to app_writer;
grant select on public.onboarding_states to app_writer;
create policy ai_usage_writer on public.ai_usage for all to app_writer
  using (user_id = (select public.request_uid())) with check (user_id = (select public.request_uid()));
create policy ai_usage_daily_writer on public.ai_usage_daily for all to app_writer
  using (user_id = (select public.request_uid())) with check (user_id = (select public.request_uid()));
create policy ai_calls_writer on public.ai_calls for all to app_writer
  using (user_id = (select public.request_uid())) with check (user_id = (select public.request_uid()));
create policy ai_global_writer on public.ai_global_daily for all to app_writer using (true) with check (true);
create policy demo_access_writer on public.demo_access for all to app_writer
  using (user_id = (select public.request_uid())) with check (user_id = (select public.request_uid()));
create policy onboarding_states_writer_read on public.onboarding_states for select to app_writer
  using (user_id = (select public.request_uid()));

-- ── Plan resolution for AI limits (demo simulation first, then the real subscription) ──────────────────
create function public.ai_effective_plan(p_uid uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select d.simulated_plan from public.demo_access d where d.user_id = p_uid),
    (select case
       when s.status = 'trialing' and s.trial_ends_at > now() then 'trial'
       when s.plan = 'plus' and (s.status = 'active' or (s.status = 'past_due' and s.current_period_end > now())) then 'plus'
       else 'free' end
     from public.subscriptions s where s.user_id = p_uid),
    'free')
$$;

create function public.ai_cfg(p_key text) returns integer language sql stable security definer set search_path = '' as $$
  select value from public.plan_config where key = p_key
$$;

-- Lima calendar (UTC-5, no DST) for monthly buckets and daily limits.
create function public.ai_lima_now() returns timestamp language sql stable set search_path = '' as $$
  select (now() at time zone 'America/Lima')
$$;

/**
 * Reserve one inference call BEFORE calling the provider. Picks the bucket (onboarding allowance while the
 * onboarding is active and has room, else the plan bucket), enforces token/camera quotas, per-day rate limits and
 * the per-user and global cost guards, and counts the request (and the camera read) atomically.
 * Raises: ai_quota | camera_quota | ai_rate | ai_budget | too_many_images | not_authenticated.
 */
create function public.ai_reserve(p_operation text, p_camera boolean default false, p_images integer default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.request_uid();
  v_plan text;
  v_month text := 'm:' || to_char(public.ai_lima_now(), 'YYYY-MM');
  v_day date := public.ai_lima_now()::date;
  v_onb boolean;
  v_bucket text;
  v_tok_limit bigint;
  v_cam_limit integer;
  v_used public.ai_usage%rowtype;
  v_daily public.ai_usage_daily%rowtype;
  v_global public.ai_global_daily%rowtype;
  v_call bigint;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_operation !~ '^[a-z_]{3,40}$' then raise exception 'bad_operation' using errcode = '22023'; end if;
  if p_images < 0 or p_images > coalesce(public.ai_cfg('ai_max_images_per_read'), 3) then
    raise exception 'too_many_images' using errcode = 'P0001';
  end if;
  v_plan := public.ai_effective_plan(v_uid);

  insert into public.ai_usage (user_id, bucket) values (v_uid, 'onboarding'), (v_uid, v_month) on conflict do nothing;
  if v_plan = 'trial' then insert into public.ai_usage (user_id, bucket) values (v_uid, 'trial') on conflict do nothing; end if;

  -- Onboarding allowance first (independent of the plan, §39), then the plan bucket.
  select exists (select 1 from public.onboarding_states o where o.user_id = v_uid and o.status = 'active') into v_onb;
  if v_onb then
    select * into v_used from public.ai_usage where user_id = v_uid and bucket = 'onboarding' for update;
    if (not p_camera and v_used.weighted_tokens < public.ai_cfg('ai_onboarding_tokens'))
       or (p_camera and v_used.camera_reads < public.ai_cfg('ai_onboarding_camera_reads')) then
      v_bucket := 'onboarding';
    end if;
  end if;
  if v_bucket is null then
    v_bucket := case v_plan when 'trial' then 'trial' else v_month end;
    select * into v_used from public.ai_usage where user_id = v_uid and bucket = v_bucket for update;
  end if;
  v_tok_limit := public.ai_cfg(case when v_bucket = 'onboarding' then 'ai_onboarding_tokens' when v_plan = 'trial' then 'ai_trial_tokens'
    when v_plan = 'plus' then 'ai_plus_monthly_tokens' else 'ai_free_monthly_tokens' end);
  v_cam_limit := public.ai_cfg(case when v_bucket = 'onboarding' then 'ai_onboarding_camera_reads' when v_plan = 'trial' then 'ai_trial_camera_reads'
    when v_plan = 'plus' then 'ai_plus_monthly_camera_reads' else 'ai_free_monthly_camera_reads' end);
  if p_camera and v_used.camera_reads >= v_cam_limit then raise exception 'camera_quota' using errcode = 'P0001'; end if;
  if not p_camera and v_used.weighted_tokens >= v_tok_limit then raise exception 'ai_quota' using errcode = 'P0001'; end if;

  insert into public.ai_usage_daily (user_id, day) values (v_uid, v_day) on conflict do nothing;
  select * into v_daily from public.ai_usage_daily where user_id = v_uid and day = v_day for update;
  if v_daily.requests >= public.ai_cfg(case when v_plan = 'free' then 'ai_free_daily_requests' else 'ai_plus_daily_requests' end)
     or (p_camera and v_daily.camera_reads >= public.ai_cfg(case when v_plan = 'free' then 'ai_free_daily_camera_reads' else 'ai_plus_daily_camera_reads' end)) then
    raise exception 'ai_rate' using errcode = 'P0001';
  end if;
  if v_daily.est_cost_micro_usd >= public.ai_cfg('ai_user_daily_budget_micro_usd') then raise exception 'ai_budget' using errcode = 'P0001'; end if;
  insert into public.ai_global_daily (day) values (v_day) on conflict do nothing;
  select * into v_global from public.ai_global_daily where day = v_day for update;
  if v_global.est_cost_micro_usd >= public.ai_cfg('ai_global_daily_budget_micro_usd') then raise exception 'ai_budget' using errcode = 'P0001'; end if;

  update public.ai_usage set requests = requests + 1, camera_reads = camera_reads + (case when p_camera then 1 else 0 end), updated_at = now()
    where user_id = v_uid and bucket = v_bucket;
  update public.ai_usage_daily set requests = requests + 1, camera_reads = camera_reads + (case when p_camera then 1 else 0 end)
    where user_id = v_uid and day = v_day;
  update public.ai_global_daily set requests = requests + 1 where day = v_day;
  insert into public.ai_calls (user_id, bucket, operation, images, camera) values (v_uid, v_bucket, p_operation, p_images, p_camera)
    returning id into v_call;
  return jsonb_build_object('call_id', v_call, 'bucket', v_bucket, 'plan', v_plan, 'remaining_tokens', greatest(v_tok_limit - v_used.weighted_tokens, 0));
end $$;

/**
 * Settle a reserved call with what the provider actually reported (tokens are the provider's numbers). Each
 * reservation settles exactly once. A camera read whose call failed is given back, so a provider failure never
 * costs the user a read (§73); a retry is a new reservation.
 */
create function public.ai_record(p_call_id bigint, p_provider text, p_model text,
  p_input integer, p_output integer, p_cached integer, p_image integer,
  p_cost_micro_usd integer, p_latency_ms integer, p_attempt integer, p_outcome text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.request_uid();
  v_call public.ai_calls%rowtype;
  v_weighted bigint;
  v_refund integer;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if least(p_input, p_output, p_cached, p_image, p_cost_micro_usd) < 0 or p_outcome = 'pending' then
    raise exception 'bad_usage' using errcode = '22023';
  end if;
  select * into v_call from public.ai_calls where id = p_call_id and user_id = v_uid and outcome = 'pending' for update;
  if not found then raise exception 'bad_call' using errcode = '22023'; end if;
  v_weighted := p_input + (p_output::bigint * public.ai_cfg('ai_weight_output_pct')) / 100
    + (p_cached::bigint * public.ai_cfg('ai_weight_cached_pct')) / 100 + (p_image::bigint * public.ai_cfg('ai_weight_image_pct')) / 100;
  v_refund := case when v_call.camera and p_outcome <> 'ok' then 1 else 0 end;
  update public.ai_calls set provider = p_provider, model = p_model, input_tokens = p_input, output_tokens = p_output,
    cached_tokens = p_cached, image_tokens = p_image, est_cost_micro_usd = p_cost_micro_usd, latency_ms = p_latency_ms,
    attempt = p_attempt, outcome = p_outcome
  where id = p_call_id;
  update public.ai_usage set weighted_tokens = weighted_tokens + v_weighted,
    text_input_tokens = text_input_tokens + p_input, text_output_tokens = text_output_tokens + p_output,
    cached_input_tokens = cached_input_tokens + p_cached, vision_input_tokens = vision_input_tokens + p_image,
    est_cost_micro_usd = est_cost_micro_usd + p_cost_micro_usd, errors = errors + (case when p_outcome = 'ok' then 0 else 1 end),
    camera_reads = greatest(camera_reads - v_refund, 0), updated_at = now()
  where user_id = v_uid and bucket = v_call.bucket;
  update public.ai_usage_daily set est_cost_micro_usd = est_cost_micro_usd + p_cost_micro_usd,
    camera_reads = greatest(camera_reads - v_refund, 0)
  where user_id = v_uid and day = (v_call.created_at at time zone 'America/Lima')::date;
  update public.ai_global_daily set est_cost_micro_usd = est_cost_micro_usd + p_cost_micro_usd
  where day = (v_call.created_at at time zone 'America/Lima')::date;
  return v_weighted;
end $$;

-- Demo only: choose which plan the AI limits simulate (null = real plan). Requires an allowlisted row.
create function public.set_demo_plan(p_plan text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public.request_uid();
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if p_plan is not null and p_plan not in ('free', 'trial', 'plus') then raise exception 'bad_plan' using errcode = '22023'; end if;
  update public.demo_access set simulated_plan = p_plan where user_id = v_uid;
  if not found then raise exception 'not_demo' using errcode = '42501'; end if;
end $$;

-- Demo only: give back the one-time onboarding allowance (usage rows are zeroed, never deleted).
create function public.reset_demo_ai_onboarding() returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public.request_uid();
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if not exists (select 1 from public.demo_access where user_id = v_uid) then raise exception 'not_demo' using errcode = '42501'; end if;
  update public.ai_usage set weighted_tokens = 0, text_input_tokens = 0, text_output_tokens = 0, vision_input_tokens = 0,
    cached_input_tokens = 0, requests = 0, camera_reads = 0, errors = 0, updated_at = now()
  where user_id = v_uid and bucket = 'onboarding';
end $$;

-- Demo only: balances are append-only for users (ADR-0005), so the exact demo reset removes the snapshots its own
-- onboarding created through this narrow function (allowlisted users, own rows, ids recorded at "Empezar").
create function public.delete_demo_balance_snapshots(p_ids uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public.request_uid(); v_n integer;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if not exists (select 1 from public.demo_access where user_id = v_uid) then raise exception 'not_demo' using errcode = '42501'; end if;
  if coalesce(array_length(p_ids, 1), 0) > 20 then raise exception 'too_many' using errcode = '22023'; end if;
  delete from public.balance_snapshots where user_id = v_uid and id = any (p_ids);
  get diagnostics v_n = row_count;
  return v_n;
end $$;
grant select, delete on public.balance_snapshots to app_writer;
create policy balance_snapshots_demo_writer on public.balance_snapshots for all to app_writer
  using (user_id = (select public.request_uid())) with check (user_id = (select public.request_uid()));

grant create on schema public to app_writer;
alter function public.delete_demo_balance_snapshots(uuid[]) owner to app_writer;
alter function public.ai_effective_plan(uuid) owner to app_writer;
alter function public.ai_cfg(text) owner to app_writer;
alter function public.ai_reserve(text, boolean, integer) owner to app_writer;
alter function public.ai_record(bigint, text, text, integer, integer, integer, integer, integer, integer, integer, text) owner to app_writer;
alter function public.set_demo_plan(text) owner to app_writer;
alter function public.reset_demo_ai_onboarding() owner to app_writer;
revoke create on schema public from app_writer;
grant select on public.subscriptions to app_writer;
revoke execute on function public.ai_effective_plan(uuid), public.ai_cfg(text), public.ai_lima_now() from public, anon, authenticated;
revoke execute on function public.delete_demo_balance_snapshots(uuid[]) from public, anon;
grant execute on function public.delete_demo_balance_snapshots(uuid[]) to authenticated;
revoke execute on function public.ai_reserve(text, boolean, integer), public.set_demo_plan(text), public.reset_demo_ai_onboarding(),
  public.ai_record(bigint, text, text, integer, integer, integer, integer, integer, integer, integer, text) from public, anon;
grant execute on function public.ai_lima_now() to app_writer;
grant execute on function public.ai_reserve(text, boolean, integer), public.set_demo_plan(text), public.reset_demo_ai_onboarding(),
  public.ai_record(bigint, text, text, integer, integer, integer, integer, integer, integer, integer, text) to authenticated;
