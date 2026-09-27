-- LOCAL TEST ONLY. Emulates the pieces of Supabase the migrations rely on
-- (roles, auth.users, auth.uid()) so RLS can be tested on plain PostgreSQL.
-- Never apply this to a Supabase project: Supabase already provides these objects.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create table auth.users (id uuid primary key, email text unique);

create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
