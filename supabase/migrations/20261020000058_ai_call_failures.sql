-- AI call diagnostics (ADR-0020): why a provider call failed, kept with its metric row so the failure rate can be
-- read from the database (timeout vs 429 vs 5xx), not only from server logs. Never the provider's message, the
-- prompt or the answer: a normalized kind and the HTTP status only.
-- * ai_calls.error_kind / http_status: nullable, constrained; null for successful and older calls.
-- * ai_record gains a 13-argument overload that settles exactly like the 11-argument one and then stores both.
--   The 11-argument form stays (no DROP): calls without diagnostics keep working.
-- Clients still cannot read or write ai_calls; both functions run as app_writer for the caller's own pending call.

alter table public.ai_calls
  add column error_kind text check (error_kind ~ '^[a-z_]{2,30}$'),
  add column http_status smallint check (http_status between 100 and 599);

create function public.ai_record(p_call_id bigint, p_provider text, p_model text,
  p_input integer, p_output integer, p_cached integer, p_image integer,
  p_cost_micro_usd integer, p_latency_ms integer, p_attempt integer, p_outcome text,
  p_error_kind text, p_http_status integer)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public.request_uid();
  v_weighted bigint;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if (p_error_kind is not null and p_error_kind !~ '^[a-z_]{2,30}$') or (p_http_status is not null and p_http_status not between 100 and 599)
     or (p_outcome = 'ok' and (p_error_kind is not null or p_http_status is not null)) then
    raise exception 'bad_usage' using errcode = '22023';
  end if;
  -- Same checks, accounting and single settlement as before (raises bad_call for another user's or a settled call).
  v_weighted := public.ai_record(p_call_id, p_provider, p_model, p_input, p_output, p_cached, p_image,
    p_cost_micro_usd, p_latency_ms, p_attempt, p_outcome);
  update public.ai_calls set error_kind = p_error_kind, http_status = p_http_status
  where id = p_call_id and user_id = v_uid;
  return v_weighted;
end $$;

grant create on schema public to app_writer;
alter function public.ai_record(bigint, text, text, integer, integer, integer, integer, integer, integer, integer, text, text, integer) owner to app_writer;
revoke create on schema public from app_writer;
revoke execute on function public.ai_record(bigint, text, text, integer, integer, integer, integer, integer, integer, integer, text, text, integer) from public, anon;
grant execute on function public.ai_record(bigint, text, text, integer, integer, integer, integer, integer, integer, integer, text, text, integer) to authenticated;
