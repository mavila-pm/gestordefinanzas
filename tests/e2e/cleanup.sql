-- E2E cleanup: remove every probe user (cascade) and prove nothing is left.
-- Expected result: one row with probe_users = 0 and orphan_rows = 0.
delete from auth.users where email like 'e2e-%@gestordefinanzas.invalid';
select
  (select count(*) from auth.users where email like 'e2e-%@gestordefinanzas.invalid') as probe_users,
  (select coalesce(sum((xpath('/row/c/text()', query_to_xml(
     format('select count(*) as c from public.%I where user_id is not null and user_id not in (select id from auth.users)', c.table_name),
     false, true, '')))[1]::text::int), 0)
   from information_schema.columns c join information_schema.tables t using (table_schema, table_name)
   where c.table_schema = 'public' and c.column_name = 'user_id' and t.table_type = 'BASE TABLE') as orphan_rows;
