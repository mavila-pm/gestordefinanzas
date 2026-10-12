-- rls_auto_enable() is the SECURITY DEFINER function behind Supabase's `ensure_rls` event trigger
-- (created by the platform when "automatic RLS" is enabled). It had default PUBLIC EXECUTE, so it was
-- exposed as /rest/v1/rpc/rls_auto_enable to anon and authenticated (Supabase advisors 0028/0029).
-- Event triggers do not need EXECUTE for the invoking role, so revoking it keeps the trigger working.
-- Guarded: the function only exists on the Supabase project, not on local test databases.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;
