-- Business core (CRM, projects, tasks, activities) security and integrity tests.
begin;
create extension if not exists pgtap with schema extensions;

select plan(30);

-- owner, member, viewer of Libz; outsider owns a different business.
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('eeeeeeee-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'biz-owner@example.com', now()),
  ('eeeeeeee-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'biz-member@example.com', now()),
  ('eeeeeeee-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'biz-viewer@example.com', now()),
  ('eeeeeeee-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'outsider@example.com', now());

insert into public.workspaces (id, type, name, owner_id) values
  ('ffffffff-0000-0000-0000-000000000001', 'business', 'Libz', 'eeeeeeee-0000-0000-0000-000000000001'),
  ('ffffffff-0000-0000-0000-000000000002', 'business', 'Other Co', 'eeeeeeee-0000-0000-0000-000000000004');
insert into public.workspace_members (workspace_id, user_id, role) values
  ('ffffffff-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000001', 'owner'),
  ('ffffffff-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000002', 'member'),
  ('ffffffff-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000003', 'viewer'),
  ('ffffffff-0000-0000-0000-000000000002', 'eeeeeeee-0000-0000-0000-000000000004', 'owner');

create temp table vars (k text primary key, v text);
grant all on vars to authenticated;
insert into vars select 'owner_personal', id::text from public.workspaces
  where owner_id = 'eeeeeeee-0000-0000-0000-000000000001' and type = 'personal';
insert into vars select 'member_personal', id::text from public.workspaces
  where owner_id = 'eeeeeeee-0000-0000-0000-000000000002' and type = 'personal';

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
grant execute on function pg_temp.login(uuid) to authenticated;

set local role authenticated;

-- ---------------------------------------------------------------- member writes
select pg_temp.login('eeeeeeee-0000-0000-0000-000000000002');

with c as (
  insert into public.companies (workspace_id, name, email, phone_e164)
  values ('ffffffff-0000-0000-0000-000000000001', 'Harare Logistics', 'info@harare-logistics.example', '+263772000001')
  returning id
) insert into vars select 'company', id::text from c;
select ok((select v from vars where k = 'company') is not null, 'a member can add a company');

with c as (
  insert into public.contacts (workspace_id, company_id, full_name, email)
  values ('ffffffff-0000-0000-0000-000000000001', (select v::uuid from vars where k = 'company'), 'Tendai Moyo', 'tendai@harare-logistics.example')
  returning id
) insert into vars select 'contact', id::text from c;
select ok((select v from vars where k = 'contact') is not null, 'a member can add a contact at a company');

with d as (
  insert into public.deals (workspace_id, company_id, contact_id, title, value)
  values ('ffffffff-0000-0000-0000-000000000001', (select v::uuid from vars where k = 'company'),
          (select v::uuid from vars where k = 'contact'), 'WhatsApp automation', 1500)
  returning id
) insert into vars select 'deal', id::text from d;
select is((select stage::text from public.deals where id = (select v::uuid from vars where k = 'deal')), 'lead',
  'new deals start as leads');

select throws_ok(
  $$insert into public.companies (workspace_id, name, email) values ('ffffffff-0000-0000-0000-000000000001', 'Dup', 'info@harare-logistics.example')$$,
  '23505', null, 'duplicate company email in one workspace is rejected');
select throws_ok(
  $$insert into public.contacts (workspace_id, full_name, marketing_consent) values ('ffffffff-0000-0000-0000-000000000001', 'No proof', 'granted')$$,
  '23514', null, 'granted consent needs a date and source');
select lives_ok(
  $$insert into public.contacts (workspace_id, full_name, marketing_consent, consent_at, consent_source)
    values ('ffffffff-0000-0000-0000-000000000001', 'Opted in', 'granted', now(), 'Signed form at event')$$,
  'consent with date and source is accepted');
select throws_ok(
  $$insert into public.contacts (workspace_id, full_name, phone_e164) values ('ffffffff-0000-0000-0000-000000000001', 'Bad phone', '0772 000 001')$$,
  '23514', null, 'phone numbers must be E.164');

-- Stage tracking and audit.
update public.deals set stage = 'won' where id = (select v::uuid from vars where k = 'deal');
select ok((select closed_at is not null from public.deals where id = (select v::uuid from vars where k = 'deal')),
  'winning a deal sets closed_at');
update public.deals set stage = 'negotiation' where id = (select v::uuid from vars where k = 'deal');
select ok((select closed_at is null from public.deals where id = (select v::uuid from vars where k = 'deal')),
  'reopening a deal clears closed_at');

-- Tasks with assignee rules and completion tracking.
with t as (
  insert into public.tasks (workspace_id, title, deal_id, assignee_id)
  values ('ffffffff-0000-0000-0000-000000000001', 'Send proposal', (select v::uuid from vars where k = 'deal'),
          'eeeeeeee-0000-0000-0000-000000000001')
  returning id
) insert into vars select 'task', id::text from t;
update public.tasks set status = 'done' where id = (select v::uuid from vars where k = 'task');
select ok((select completed_at is not null from public.tasks where id = (select v::uuid from vars where k = 'task')),
  'completing a task sets completed_at');
select throws_ok(
  $$insert into public.tasks (workspace_id, title, assignee_id) values ('ffffffff-0000-0000-0000-000000000001', 'x', 'eeeeeeee-0000-0000-0000-000000000004')$$,
  'P0001', null, 'tasks cannot be assigned to non-members');

select lives_ok(
  $$insert into public.activities (workspace_id, type, direction, summary, company_id, contact_id)
    values ('ffffffff-0000-0000-0000-000000000001', 'call', 'outbound', 'Intro call; interested in a pilot',
            (select v::uuid from vars where k = 'company'), (select v::uuid from vars where k = 'contact'))$$,
  'members can log activities');

select throws_ok(
  $$update public.companies set workspace_id = 'ffffffff-0000-0000-0000-000000000002' where id = (select v::uuid from vars where k = 'company')$$,
  '42501', null, 'records cannot be moved to another workspace');
select throws_ok(
  $$update public.companies set created_by = 'eeeeeeee-0000-0000-0000-000000000004'$$,
  '42501', null, 'authorship cannot be rewritten');

with d as (delete from public.companies where id = (select v::uuid from vars where k = 'company') returning 1)
select is(count(*), 0::bigint, 'members cannot delete companies') from d;

-- Personal workspace: tasks yes, CRM no.
select throws_ok(
  $$insert into public.companies (workspace_id, name) values ((select v::uuid from vars where k = 'member_personal'), 'Personal Co')$$,
  'P0001', null, 'CRM records are business-only');
select lives_ok(
  $$insert into public.tasks (workspace_id, title) values ((select v::uuid from vars where k = 'member_personal'), 'Buy groceries')$$,
  'personal tasks are allowed');

-- ------------------------------------------------------------------- viewer
select pg_temp.login('eeeeeeee-0000-0000-0000-000000000003');
select is((select count(*) from public.companies), 1::bigint, 'viewers can read workspace companies');
select is((select count(*) from public.tasks), 1::bigint, 'viewers see business tasks but not others'' personal tasks');
select throws_ok(
  $$insert into public.companies (workspace_id, name) values ('ffffffff-0000-0000-0000-000000000001', 'Viewer Co')$$,
  '42501', null, 'viewers cannot create records');
with u as (update public.deals set value = 1 returning 1)
select is(count(*), 0::bigint, 'viewers cannot edit deals') from u;

-- ----------------------------------------------------------------- outsider
select pg_temp.login('eeeeeeee-0000-0000-0000-000000000004');
select is((select count(*) from public.companies), 0::bigint, 'outsiders see no Libz companies');
select is((select count(*) from public.deals), 0::bigint, 'outsiders see no Libz deals');
select throws_ok(
  $$insert into public.companies (workspace_id, name) values ('ffffffff-0000-0000-0000-000000000001', 'Intruder')$$,
  '42501', null, 'outsiders cannot write into Libz');
select throws_ok(
  $$insert into public.contacts (workspace_id, full_name, company_id)
    values ('ffffffff-0000-0000-0000-000000000002', 'Cross link', (select v::uuid from vars where k = 'company'))$$,
  'P0002', null, 'records cannot reference another workspace''s company');
select lives_ok(
  $$insert into public.companies (workspace_id, name, email) values ('ffffffff-0000-0000-0000-000000000002', 'Other', 'info@harare-logistics.example')$$,
  'the same email is allowed in a different workspace');

-- -------------------------------------------------------------------- owner
select pg_temp.login('eeeeeeee-0000-0000-0000-000000000001');
select is(
  (select metadata ->> 'to' from public.audit_logs
   where action = 'deal.stage_changed' and target_id = (select v from vars where k = 'deal')
   order by id desc limit 1),
  'negotiation', 'deal stage changes are audited with from/to');
select is(
  (select count(*) from public.audit_logs where action = 'task.completed'
     and workspace_id = 'ffffffff-0000-0000-0000-000000000001'),
  1::bigint, 'task completion is audited');
select is(
  (select count(*) from public.audit_logs where workspace_id = 'ffffffff-0000-0000-0000-000000000001'
     and metadata::text ilike '%Harare%'),
  0::bigint, 'audit entries never contain record content');
with d as (delete from public.companies where id = (select v::uuid from vars where k = 'company') returning 1)
select is(count(*), 1::bigint, 'admins can delete companies (cascading their deals)') from d;

select * from finish();
rollback;
