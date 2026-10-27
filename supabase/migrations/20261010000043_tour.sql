-- First-run tutorial (recorrido de la app): when the person finished or skipped it, so it is shown once per account and
-- not on every sign-in. null = not seen yet (or restarted from Ajustes → Ayuda). Own row only (existing RLS/grants).
alter table public.user_preferences add column tour_completed_at timestamptz;
