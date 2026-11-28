-- Memory privacy and isolation tests. Run with `pnpm db:test`.
begin;
create extension if not exists pgtap with schema extensions;

select plan(16);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
values
  ('cccccccc-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'mem-owner@example.com', now()),
  ('cccccccc-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'mem-colleague@example.com', now());

create temp table vars (k text primary key, v text);
grant all on vars to authenticated;

-- A business workspace shared by both users; each also has a personal workspace.
insert into public.workspaces (id, type, name, owner_id)
values ('dddddddd-0000-0000-0000-000000000001', 'business', 'Shared Biz', 'cccccccc-0000-0000-0000-000000000001');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('dddddddd-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'owner'),
  ('dddddddd-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000002', 'member');
insert into vars
  select 'personal', id::text from public.workspaces
  where owner_id = 'cccccccc-0000-0000-0000-000000000001' and type = 'personal';

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
grant execute on function pg_temp.login(uuid) to authenticated;

set local role authenticated;
select pg_temp.login('cccccccc-0000-0000-0000-000000000001');

insert into public.memories (workspace_id, content, category, pinned)
values ((select v::uuid from vars where k = 'personal'), 'I prefer meetings after 10am', 'preference', true);
insert into public.memories (workspace_id, content, category)
values ('dddddddd-0000-0000-0000-000000000001', 'Our main client is Acme', 'fact');

select is((select count(*) from public.memories), 2::bigint, 'the owner sees their memories in both workspaces');
select is(
  (select count(*) from public.memories where workspace_id = 'dddddddd-0000-0000-0000-000000000001'),
  1::bigint, 'memories are scoped to their workspace');
select is(
  (select content from public.memories where workspace_id = (select v::uuid from vars where k = 'personal')),
  'I prefer meetings after 10am', 'personal memory stays in the personal workspace');

select throws_ok(
  $$insert into public.memories (workspace_id, content) values ((select v::uuid from vars where k = 'personal'), '   ')$$,
  '23514', null, 'empty memories are rejected');
select throws_ok(
  $$insert into public.memories (workspace_id, content) values ((select v::uuid from vars where k = 'personal'), repeat('x', 1001))$$,
  '23514', null, 'over-long memories are rejected');
select throws_ok(
  $$insert into public.memories (workspace_id, content, category) values ((select v::uuid from vars where k = 'personal'), 'x', 'secret')$$,
  '23514', null, 'unknown categories are rejected');
select throws_ok(
  $$insert into public.memories (workspace_id, user_id, content)
    values ((select v::uuid from vars where k = 'personal'), 'cccccccc-0000-0000-0000-000000000002', 'forged')$$,
  '42501', null, 'memories cannot be created on behalf of someone else');
select throws_ok(
  $$insert into public.memories (workspace_id, content, source, source_message_id)
    values ((select v::uuid from vars where k = 'personal'), 'from a stranger''s message', 'message', gen_random_uuid())$$,
  'P0002', null, 'a memory cannot cite a message that is not the author''s');

with u as (update public.memories set pinned = true where workspace_id = 'dddddddd-0000-0000-0000-000000000001' returning 1)
select is(count(*), 1::bigint, 'the owner can pin a memory') from u;

-- The colleague shares the business workspace but must not see the owner's memories.
select pg_temp.login('cccccccc-0000-0000-0000-000000000002');
select is((select count(*) from public.memories), 0::bigint, 'colleagues cannot read each other''s memories');
with u as (update public.memories set content = 'tampered' returning 1)
select is(count(*), 0::bigint, 'colleagues cannot edit each other''s memories') from u;
with d as (delete from public.memories returning 1)
select is(count(*), 0::bigint, 'colleagues cannot delete each other''s memories') from d;
select throws_ok(
  $$insert into public.memories (workspace_id, content) values ((select v::uuid from vars where k = 'personal'), 'intrusion')$$,
  '42501', null, 'non-members cannot add memories to a workspace');

-- Admins see that memories changed, never their content.
select pg_temp.login('cccccccc-0000-0000-0000-000000000001');
select is(
  (select count(*) from public.audit_logs
   where workspace_id = 'dddddddd-0000-0000-0000-000000000001' and action = 'memory.created'),
  1::bigint, 'memory creation is audited');
select is(
  (select count(*) from public.audit_logs
   where action = 'memory.created' and metadata::text ilike '%Acme%'),
  0::bigint, 'audit entries never contain memory content');

reset role;
delete from public.workspace_members
where workspace_id = 'dddddddd-0000-0000-0000-000000000001' and user_id = 'cccccccc-0000-0000-0000-000000000002';
set local role authenticated;
select pg_temp.login('cccccccc-0000-0000-0000-000000000001');
select is((select count(*) from public.memories), 2::bigint, 'the owner still sees their memories');

select * from finish();
rollback;
