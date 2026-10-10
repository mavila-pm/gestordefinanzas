-- E2E cleanup: remove every synthetic probe user (all runs) and prove nothing is left.
-- Expected result: one row with probe_users = 0 and orphan_rows = 0.
-- Scope is exact: only e2e-<tag>[-<run>]@gestordefinanzas.invalid (the non-deliverable .invalid TLD, RFC 2606).
-- Every public row of a probe user goes with it through the user_id cascades (ON DELETE CASCADE on all tables).
do $$
declare n int; outside int;
begin
  select count(*) into n from auth.users where email like 'e2e-%@gestordefinanzas.invalid';
  -- Guard: the like-match must be exactly the synthetic pattern; anything else aborts before deleting.
  select count(*) into outside from auth.users
    where email like 'e2e-%@gestordefinanzas.invalid' and email !~ '^e2e-s[0-9]+[ab](-[a-z0-9]{8,20})?@gestordefinanzas\.invalid$';
  if outside > 0 then raise exception 'e2e cleanup: % user(s) match the prefix but not the synthetic pattern; nothing deleted', outside; end if;
  if n > 400 then raise exception 'e2e cleanup: % probe users is implausible; nothing deleted', n; end if;
  delete from auth.users where email ~ '^e2e-s[0-9]+[ab](-[a-z0-9]{8,20})?@gestordefinanzas\.invalid$';
end $$;
select
  (select count(*) from auth.users where email like 'e2e-%@gestordefinanzas.invalid') as probe_users,
  (select coalesce(sum((xpath('/row/c/text()', query_to_xml(
     format('select count(*) as c from public.%I where user_id is not null and user_id not in (select id from auth.users)', c.table_name),
     false, true, '')))[1]::text::int), 0)
   from information_schema.columns c join information_schema.tables t using (table_schema, table_name)
   where c.table_schema = 'public' and c.column_name = 'user_id' and t.table_type = 'BASE TABLE') as orphan_rows;
