-- ADR-0008: the person's decisions on suggestions (never ask again what they dismissed) and an append-only
-- audit trail of learned-data changes (corrections, undo, forget). Financial events are never touched here.

-- "Ahora no" snoozes a suggestion until a date; "Descartar" hides it for that value (a materially different
-- observed value may be suggested again). One decision per (kind, subject).
create table public.suggestion_decisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('essentials', 'observed_amount', 'income_match', 'variation', 'payment_match')),
  subject text not null check (length(subject) between 1 and 120),
  value_minor bigint check (value_minor is null or value_minor between 0 and 100000000000),
  decision text not null check (decision in ('later', 'dismissed')),
  until date,
  created_at timestamptz not null default now(),
  check ((decision = 'later') = (until is not null)),
  unique (id, user_id),
  unique (user_id, kind, subject)
);

-- What changed in learned data, by whom (always the owner), never the financial movements themselves.
create table public.learning_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  entity text not null check (entity in ('onboarding', 'rule', 'settlement', 'obligation', 'income', 'essentials', 'suggestion', 'preference')),
  entity_id uuid,
  action text not null check (action in ('accepted', 'corrected', 'invalidated', 'deleted', 'dismissed', 'snoozed', 'restored')),
  detail jsonb not null default '{}'::jsonb check (pg_column_size(detail) <= 4000),
  created_at timestamptz not null default now(),
  unique (id, user_id)
);
create index learning_events_user on public.learning_events (user_id, created_at desc);

alter table public.suggestion_decisions enable row level security;
alter table public.learning_events enable row level security;
revoke all on public.suggestion_decisions, public.learning_events from anon, authenticated;
grant select, insert, update, delete on public.suggestion_decisions to authenticated;
-- The trail is append-only for the person (no rewrite, no selective erase); it goes away with the account.
grant select, insert on public.learning_events to authenticated;
create policy suggestion_decisions_own on public.suggestion_decisions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy learning_events_own on public.learning_events for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
