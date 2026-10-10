-- Monthly savings goal (Resumen / Análisis): an explicit amount the person sets; never inferred. Null = no goal.
-- Same table, same RLS (own rows) and grants as the other planning settings.
alter table public.planning_settings add column savings_goal_minor bigint
  check (savings_goal_minor between 1 and 100000000000);
comment on column public.planning_settings.savings_goal_minor is 'Monthly savings goal set by the person (minor units). Null = none.';
