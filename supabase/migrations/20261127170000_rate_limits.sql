-- =============================================================================
-- Phase 1F — global per-user rate limits.
--
-- Serverless API instances do not share memory, so counters live in Postgres.
-- Fixed windows per (user, bucket); one atomic upsert per check. Users can only
-- ever touch their own counters, so calling this directly is harmless.
-- =============================================================================

create table private.rate_limits (
  user_id uuid not null references auth.users (id) on delete cascade,
  bucket text not null check (char_length(bucket) between 1 and 50),
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (user_id, bucket, window_start)
);
create index rate_limits_window_idx on private.rate_limits (window_start);

-- Returns {allowed, count, retry_after_seconds}.
create function public.consume_rate_limit(p_bucket text, p_limit integer, p_window_seconds integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := private.require_user();
  v_window timestamptz;
  v_count integer;
begin
  if p_limit < 1 or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'invalid rate limit' using errcode = 'P0001';
  end if;
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into private.rate_limits as r (user_id, bucket, window_start, count)
  values (v_user, p_bucket, v_window, 1)
  on conflict (user_id, bucket, window_start) do update set count = r.count + 1
  returning count into v_count;

  -- Occasional cleanup keeps the table small without a scheduler.
  if random() < 0.01 then
    delete from private.rate_limits where window_start < now() - interval '1 day';
  end if;

  return jsonb_build_object(
    'allowed', v_count <= p_limit,
    'count', v_count,
    'retry_after_seconds',
      greatest(1, ceil(extract(epoch from (v_window + make_interval(secs => p_window_seconds) - now())))::integer)
  );
end;
$$;
revoke all on function public.consume_rate_limit(text, integer, integer) from public, anon;
grant execute on function public.consume_rate_limit(text, integer, integer) to authenticated;
