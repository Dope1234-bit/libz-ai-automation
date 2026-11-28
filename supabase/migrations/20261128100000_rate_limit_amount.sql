-- =============================================================================
-- Usage budgets measured in units other than requests (e.g. characters of
-- speech). Same private counters as consume_rate_limit; adds p_amount at once.
-- =============================================================================

create function public.consume_usage(p_bucket text, p_amount integer, p_limit integer, p_window_seconds integer)
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
  if p_amount < 1 or p_amount > 1000000 or p_limit < 1 or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'invalid usage request' using errcode = 'P0001';
  end if;
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  -- Refuse without counting if this request would exceed the budget.
  select count into v_count from private.rate_limits
  where user_id = v_user and bucket = p_bucket and window_start = v_window;
  if coalesce(v_count, 0) + p_amount > p_limit then
    return jsonb_build_object('allowed', false, 'used', coalesce(v_count, 0));
  end if;

  insert into private.rate_limits as r (user_id, bucket, window_start, count)
  values (v_user, p_bucket, v_window, p_amount)
  on conflict (user_id, bucket, window_start) do update set count = r.count + p_amount
  returning count into v_count;
  return jsonb_build_object('allowed', true, 'used', v_count);
end;
$$;
revoke all on function public.consume_usage(text, integer, integer, integer) from public, anon;
grant execute on function public.consume_usage(text, integer, integer, integer) to authenticated;
