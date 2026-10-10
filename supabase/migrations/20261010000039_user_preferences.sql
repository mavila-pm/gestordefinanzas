-- Account preferences (Ajustes): how Vels talks, personal financial defaults, in-app notices. Presentation and
-- defaults only: nothing here changes how the engine computes money. One row per person, own rows only.
create table public.user_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  vels_style text not null default 'balanced' check (vels_style in ('brief', 'balanced', 'detailed')),
  vels_proactive boolean not null default true,
  primary_currency public.currency_code not null default 'PEN',
  primary_account_id uuid,
  notify_upcoming boolean not null default true,
  notify_review boolean not null default true,
  notify_monthly boolean not null default true,
  notify_limits boolean not null default true,
  updated_at timestamptz not null default now(),
  -- The main account must be one of the person's own accounts; removing it just clears the preference.
  foreign key (primary_account_id, user_id) references public.accounts (id, user_id) on delete set null (primary_account_id)
);

alter table public.user_preferences enable row level security;
revoke all on public.user_preferences from anon, authenticated;
grant select, insert, update on public.user_preferences to authenticated;
create policy user_preferences_own on public.user_preferences for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
comment on table public.user_preferences is 'Ajustes: Vels style/proactivity, primary currency/account, in-app notices. Never changes engine math.';
