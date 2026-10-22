-- TASK-006: bank notification text pasted by the user. Separate migration: a new enum value cannot be used in
-- the same transaction that adds it.
alter type public.source_channel add value if not exists 'import';
