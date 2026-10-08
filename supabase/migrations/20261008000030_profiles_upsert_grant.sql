-- Fix for 029: saving the profile name (Ajustes, Resumen) is an upsert; PostgREST's ON CONFLICT DO UPDATE sets every
-- sent column, including user_id, so UPDATE must be granted on user_id too. RLS (profiles_own: user_id = auth.uid())
-- still pins the row to the signed-in person. Registration columns stay function-only.
grant update (user_id) on public.profiles to authenticated;
