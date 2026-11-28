-- Conversation privacy and usage-ledger tests. Run with `pnpm db:test`.
begin;
create extension if not exists pgtap with schema extensions;

select plan(19);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@example.com', now()),
  ('aaaaaaaa-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'colleague@example.com', now()),
  ('aaaaaaaa-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'viewer@example.com', now());

create temp table vars (k text primary key, v text);
grant all on vars to authenticated;

-- A business workspace with the owner, a member colleague and a viewer.
insert into public.workspaces (id, type, name, owner_id)
values ('bbbbbbbb-0000-0000-0000-000000000001', 'business', 'Biz', 'aaaaaaaa-0000-0000-0000-000000000001');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'owner'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'member'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000003', 'viewer');

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
grant execute on function pg_temp.login(uuid) to authenticated;

set local role authenticated;

-- Owner starts a conversation and chats.
select pg_temp.login('aaaaaaaa-0000-0000-0000-000000000001');
with c as (
  insert into public.conversations (workspace_id) values ('bbbbbbbb-0000-0000-0000-000000000001') returning id
)
insert into vars select 'conv', id::text from c;
select ok((select v from vars where k = 'conv') is not null, 'a member can start a conversation');

select ok(
  public.add_user_message((select v::uuid from vars where k = 'conv'), '  Plan   the Q3 launch  ') is not null,
  'the owner can add a user message');
select is(
  (select title from public.conversations where id = (select v::uuid from vars where k = 'conv')),
  'Plan the Q3 launch', 'the first message titles the conversation');

select ok(
  public.add_assistant_message((select v::uuid from vars where k = 'conv'), 'Here is a plan.', 'complete',
    'gemini', 'gemini-test', 120, 30) is not null,
  'the assistant reply is stored');
select is(public.ai_tokens_used_today(), 150::bigint, 'usage is recorded in the ledger');
select is((select count(*) from public.messages), 2::bigint, 'the owner sees both messages');

select throws_ok(
  $$select public.add_user_message((select v::uuid from vars where k = 'conv'), '   ')$$,
  'P0001', null, 'empty messages are rejected');

select throws_ok(
  $$insert into public.messages (conversation_id, workspace_id, user_id, role, content)
    values ((select v::uuid from vars where k = 'conv'), 'bbbbbbbb-0000-0000-0000-000000000001',
            'aaaaaaaa-0000-0000-0000-000000000001', 'assistant', 'forged')$$,
  '42501', null, 'messages cannot be inserted directly');

select throws_ok(
  $$insert into public.ai_usage (workspace_id, user_id, provider, model, input_tokens, output_tokens)
    values ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'x', 'y', 0, 0)$$,
  '42501', null, 'the usage ledger cannot be written directly');

select throws_ok(
  $$delete from public.ai_usage$$, '42501', null, 'usage cannot be deleted to dodge limits');

select throws_ok(
  $$select public.add_assistant_message((select v::uuid from vars where k = 'conv'), 'x', 'complete', 'p', 'm', -500, 0)$$,
  '23514', null, 'negative token counts are rejected');

-- The colleague is in the same workspace but must not see the owner's chats.
select pg_temp.login('aaaaaaaa-0000-0000-0000-000000000002');
select is((select count(*) from public.conversations), 0::bigint, 'colleagues cannot see each other''s conversations');
select is((select count(*) from public.messages), 0::bigint, 'colleagues cannot read each other''s messages');
select throws_ok(
  $$select public.add_user_message((select v::uuid from vars where k = 'conv'), 'hijack')$$,
  'P0002', null, 'colleagues cannot post into another user''s conversation');
select throws_ok(
  $$insert into public.conversations (workspace_id, user_id)
    values ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001')$$,
  '42501', null, 'conversations cannot be created on behalf of someone else');
select is(public.ai_tokens_used_today(), 0::bigint, 'usage is per user');

-- Viewers are read-only and cannot spend the workspace's AI budget.
select pg_temp.login('aaaaaaaa-0000-0000-0000-000000000003');
select throws_ok(
  $$insert into public.conversations (workspace_id) values ('bbbbbbbb-0000-0000-0000-000000000001')$$,
  '42501', null, 'viewers cannot start conversations');

-- The owner (an admin) can see usage across the workspace.
select pg_temp.login('aaaaaaaa-0000-0000-0000-000000000001');
select is((select count(*) from public.ai_usage where workspace_id = 'bbbbbbbb-0000-0000-0000-000000000001'),
  1::bigint, 'workspace admins can see workspace usage');

-- Deleting a conversation removes its messages.
delete from public.conversations where id = (select v::uuid from vars where k = 'conv');
reset role;
select is((select count(*) from public.messages where conversation_id = (select v::uuid from vars where k = 'conv')),
  0::bigint, 'deleting a conversation deletes its messages');

select * from finish();
rollback;
