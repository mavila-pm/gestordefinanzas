-- ADR-0011: "pongámosle S/500 en comida" is an ESTIMATE. The status travels with the value so the plan says
-- "estimado" (estimated ≠ confirmed). Existing values were typed by the person in the settings form → confirmed.
alter table public.planning_settings add column essentials_status text not null default 'confirmed'
  check (essentials_status in ('confirmed', 'estimated'));
