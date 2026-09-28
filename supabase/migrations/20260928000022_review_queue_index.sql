-- The review badge is counted on EVERY /app render (layout) and the review queue lists the same rows: without an
-- index on status the count scans all of the user's transactions. Partial index = only the few pending rows.
create index if not exists transactions_review_queue on public.transactions (user_id, occurred_at desc)
  where status in ('review_required', 'possible_duplicate');
