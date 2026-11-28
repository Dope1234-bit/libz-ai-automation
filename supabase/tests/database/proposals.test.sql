-- Jarvis proposals: private, confirm-once, permission re-checked, audited.
begin;
create extension if not exists pgtap with schema extensions;

select plan(16);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('abababab-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'prop-owner@example.com', now()),
  ('abababab-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'prop-member@example.com', now()),
  ('abababab-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'prop-viewer@example.com', now());

insert into public.workspaces (id, type, name, owner_id) values
  ('cdcdcdcd-0000-0000-0000-000000000001', 'business', 'Libz', 'abababab-0000-0000-0000-000000000001');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('cdcdcdcd-0000-0000-0000-000000000001', 'abababab-0000-0000-0000-000000000001', 'owner'),
  ('cdcdcdcd-0000-0000-0000-000000000001', 'abababab-0000-0000-0000-000000000002', 'member'),
  ('cdcdcdcd-0000-0000-0000-000000000001', 'abababab-0000-0000-0000-000000000003', 'viewer');

insert into public.conversations (id, workspace_id, user_id) values
  ('efefefef-0000-0000-0000-000000000001', 'cdcdcdcd-0000-0000-0000-000000000001', 'abababab-0000-0000-0000-000000000002'),
  ('efefefef-0000-0000-0000-000000000002', 'cdcdcdcd-0000-0000-0000-000000000001', 'abababab-0000-0000-0000-000000000001'),
  ('efefefef-0000-0000-0000-000000000003', 'cdcdcdcd-0000-0000-0000-000000000001', 'abababab-0000-0000-0000-000000000003');
insert into public.companies (id, workspace_id, name) values
  ('12121212-0000-0000-0000-000000000001', 'cdcdcdcd-0000-0000-0000-000000000001', 'Moyo Hardware');

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
grant execute on function pg_temp.login(uuid) to authenticated;

set local role authenticated;
select pg_temp.login('abababab-0000-0000-0000-000000000002');

insert into public.ai_proposals (id, workspace_id, conversation_id, kind, payload, summary) values
  ('34343434-0000-0000-0000-000000000001', 'cdcdcdcd-0000-0000-0000-000000000001', 'efefefef-0000-0000-0000-000000000001',
   'task', '{"title": "Send quote to Moyo", "priority": "high", "company_id": "12121212-0000-0000-0000-000000000001"}', 'Task: Send quote to Moyo'),
  ('34343434-0000-0000-0000-000000000002', 'cdcdcdcd-0000-0000-0000-000000000001', 'efefefef-0000-0000-0000-000000000001',
   'activity_note', '{"type": "call", "direction": "outbound", "summary": "Called about the quote", "company_id": "12121212-0000-0000-0000-000000000001"}', 'Log call'),
  ('34343434-0000-0000-0000-000000000003', 'cdcdcdcd-0000-0000-0000-000000000001', 'efefefef-0000-0000-0000-000000000001',
   'task', '{"title": "Maybe later"}', 'Task: Maybe later');
select is((select count(*) from public.ai_proposals), 3::bigint, 'a member can store proposals in their own conversation');

select throws_ok(
  $$insert into public.ai_proposals (workspace_id, conversation_id, kind, payload, summary)
    values ('cdcdcdcd-0000-0000-0000-000000000001', 'efefefef-0000-0000-0000-000000000002', 'task', '{"title":"x"}', 'x')$$,
  '42501', null, 'cannot attach a proposal to someone else''s conversation');
select throws_ok(
  $$insert into public.ai_proposals (workspace_id, conversation_id, kind, payload, summary, status, decided_at)
    values ('cdcdcdcd-0000-0000-0000-000000000001', 'efefefef-0000-0000-0000-000000000001', 'task', '{"title":"x"}', 'x', 'confirmed', now())$$,
  '42501', null, 'cannot insert an already-confirmed proposal');
select throws_ok(
  $$update public.ai_proposals set status = 'confirmed' where id = '34343434-0000-0000-0000-000000000001'$$,
  '42501', null, 'proposals cannot be marked confirmed directly');

select is(
  (select count(*) from public.tasks where workspace_id = 'cdcdcdcd-0000-0000-0000-000000000001'),
  0::bigint, 'nothing is created before confirmation');

select isnt(public.decide_ai_proposal('34343434-0000-0000-0000-000000000001', true), null, 'confirming a task proposal returns the new task');
select is(
  (select title || '|' || priority::text || '|' || (created_by = 'abababab-0000-0000-0000-000000000002')::text
   from public.tasks where id = (select result_id from public.ai_proposals where id = '34343434-0000-0000-0000-000000000001')),
  'Send quote to Moyo|high|true', 'the task is created as the confirming user');
select throws_ok(
  $$select public.decide_ai_proposal('34343434-0000-0000-0000-000000000001', true)$$,
  'P0001', null, 'a proposal can only be confirmed once');

select public.decide_ai_proposal('34343434-0000-0000-0000-000000000002', true);
select is(
  (select type::text || '|' || source from public.activities
   where id = (select result_id from public.ai_proposals where id = '34343434-0000-0000-0000-000000000002')),
  'call|jarvis', 'confirmed notes are logged with source jarvis');

select is(public.decide_ai_proposal('34343434-0000-0000-0000-000000000003', false), null, 'dismissing creates nothing');
select is((select status from public.ai_proposals where id = '34343434-0000-0000-0000-000000000003'), 'dismissed', 'dismissal is recorded');

-- Privacy: the owner cannot see or decide the member's proposals.
select pg_temp.login('abababab-0000-0000-0000-000000000001');
select is((select count(*) from public.ai_proposals), 0::bigint, 'proposals are private to their user');
select throws_ok(
  $$select public.decide_ai_proposal('34343434-0000-0000-0000-000000000003', true)$$,
  'P0002', null, 'others cannot decide your proposals');

-- Permissions are re-checked at decision time.
reset role;
insert into public.ai_proposals (id, workspace_id, conversation_id, user_id, kind, payload, summary) values
  ('34343434-0000-0000-0000-000000000004', 'cdcdcdcd-0000-0000-0000-000000000001', 'efefefef-0000-0000-0000-000000000003',
   'abababab-0000-0000-0000-000000000003', 'task', '{"title": "Viewer task"}', 'Task');
set local role authenticated;
select pg_temp.login('abababab-0000-0000-0000-000000000003');
select throws_ok(
  $$select public.decide_ai_proposal('34343434-0000-0000-0000-000000000004', true)$$,
  '42501', null, 'viewers cannot confirm proposals');

-- Audit: created and decided, no content.
reset role;
select is(
  (select count(*) from public.audit_logs where workspace_id = 'cdcdcdcd-0000-0000-0000-000000000001'
     and action in ('jarvis.proposal_confirmed', 'jarvis.proposal_dismissed')),
  3::bigint, 'decisions are audited');
select ok(
  not exists (select 1 from public.audit_logs where metadata::text like '%Send quote%'),
  'audit entries carry no proposal content');

select * from finish();
rollback;
