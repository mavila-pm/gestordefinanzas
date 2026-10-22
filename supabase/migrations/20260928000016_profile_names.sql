-- Profile names (UX phase): full given names and family names are kept as the person wrote them; display_name is
-- the name Velsuno uses in the interface ("¿Cómo quieres que te llamemos?"), by default the first given name.
-- Presentation only: never used for authorization. Existing rows keep their display_name; nothing is invented.
alter table public.profiles
  add column given_names text check (given_names is null or (char_length(given_names) between 1 and 80 and given_names !~ '[[:cntrl:]<>]')),
  add column family_names text check (family_names is null or (char_length(family_names) between 1 and 80 and family_names !~ '[[:cntrl:]<>]'));
alter table public.profiles drop constraint if exists profiles_display_name_check;
alter table public.profiles add constraint profiles_display_name_check
  check (display_name is null or (char_length(display_name) between 1 and 40 and display_name !~ '[[:cntrl:]<>]'));
comment on column public.profiles.display_name is 'Name used in the UI (preferred / first given name). Presentation only.';
