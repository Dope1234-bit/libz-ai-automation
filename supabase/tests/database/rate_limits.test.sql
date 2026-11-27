-- Global rate limits: per user, per bucket, private counters.
begin;
create extension if not exists pgtap with schema extensions;

select plan(6);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('56565656-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rl-a@example.com', now()),
  ('56565656-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rl-b@example.com', now());

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
grant execute on function pg_temp.login(uuid) to authenticated;
set local role authenticated;

select pg_temp.login('56565656-0000-0000-0000-000000000001');
select ok((public.consume_rate_limit('t', 2, 3600) ->> 'allowed')::boolean, 'first request allowed');
select ok((public.consume_rate_limit('t', 2, 3600) ->> 'allowed')::boolean, 'second request allowed');
select ok(not (public.consume_rate_limit('t', 2, 3600) ->> 'allowed')::boolean, 'third request over the limit is refused');

select pg_temp.login('56565656-0000-0000-0000-000000000002');
select ok((public.consume_rate_limit('t', 2, 3600) ->> 'allowed')::boolean, 'other users have their own counters');

select throws_ok($$select count(*) from private.rate_limits$$, '42501', null, 'counters are not readable by users');

set local role anon;
select throws_ok($$select public.consume_rate_limit('t', 2, 60)$$, '42501', null, 'anonymous callers cannot use the limiter');

select * from finish();
rollback;
