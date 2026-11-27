-- Tenancy & row-level security tests. Run with `pnpm db:test`.
-- Each test acts as a real role (`anon` / `authenticated`) with real JWT claims,
-- so these exercise the same policies the Data API enforces.
begin;
create extension if not exists pgtap with schema extensions;

select plan(45);

-- -----------------------------------------------------------------------------
-- Fixtures (as postgres)
-- -----------------------------------------------------------------------------
-- alice: owner of a business workspace   bob: invited member
-- carol: outsider                         dave: unconfirmed email
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_user_meta_data)
values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'alice@example.com', now(), '{"display_name":"Alice"}'),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'bob@example.com', now(), '{}'),
  ('33333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol@example.com', now(), '{}'),
  ('44444444-4444-4444-4444-444444444444', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dave@example.com', null, '{}');

-- Scratch space shared across role switches.
create temp table vars (k text primary key, v text);
grant all on vars to authenticated, anon;

create function pg_temp.login(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
grant execute on function pg_temp.login(uuid) to authenticated, anon;

-- -----------------------------------------------------------------------------
-- Sign-up trigger
-- -----------------------------------------------------------------------------
select is(
  (select count(*) from public.workspaces
   where owner_id = '11111111-1111-1111-1111-111111111111' and type = 'personal'),
  1::bigint, 'sign-up creates exactly one personal workspace');

select is(
  (select display_name from public.profiles where id = '11111111-1111-1111-1111-111111111111'),
  'Alice', 'sign-up creates a profile from metadata');

select is(
  (select m.role::text from public.workspace_members m
   join public.workspaces w on w.id = m.workspace_id
   where w.owner_id = '11111111-1111-1111-1111-111111111111' and w.type = 'personal'),
  'owner', 'sign-up makes the user owner of their personal workspace');

select is(
  (select count(*) from public.audit_logs
   where actor_id = '11111111-1111-1111-1111-111111111111' and action = 'user.signed_up'),
  1::bigint, 'sign-up is audited');

-- -----------------------------------------------------------------------------
-- Anonymous clients
-- -----------------------------------------------------------------------------
set local role anon;

select throws_ok('select * from public.workspaces', '42501', null, 'anon cannot read workspaces');
select throws_ok('select * from public.profiles', '42501', null, 'anon cannot read profiles');
select throws_ok($$select public.create_business_workspace('x')$$, '42501', null,
  'anon cannot call workspace functions');

reset role;

-- -----------------------------------------------------------------------------
-- Alice: owner flows
-- -----------------------------------------------------------------------------
set local role authenticated;
select pg_temp.login('11111111-1111-1111-1111-111111111111');

select is((select count(*) from public.workspaces), 1::bigint, 'alice initially sees only her personal workspace');

insert into vars select 'acme', (public.create_business_workspace('Acme Ltd')).id::text;
select is((select count(*) from public.workspaces), 2::bigint, 'alice can create a business workspace');
select is(
  (select role::text from public.workspace_members
   where workspace_id = (select v::uuid from vars where k = 'acme')
     and user_id = '11111111-1111-1111-1111-111111111111'),
  'owner', 'creator owns the business workspace');

select throws_ok(
  $$select public.create_workspace_invitation(
      (select id from public.workspaces where type = 'personal'), 'bob@example.com', 'member')$$,
  'P0001', null, 'personal workspaces cannot invite members');

select throws_ok(
  $$select public.create_workspace_invitation((select v::uuid from vars where k = 'acme'), 'bob@example.com', 'owner')$$,
  'P0001', null, 'cannot invite someone as owner');

insert into vars select 'bob_token', token
  from public.create_workspace_invitation((select v::uuid from vars where k = 'acme'), 'Bob@Example.com ', 'member');
insert into vars select 'eve_token', token
  from public.create_workspace_invitation((select v::uuid from vars where k = 'acme'), 'eve@example.com', 'viewer');
insert into vars select 'dave_token', token
  from public.create_workspace_invitation((select v::uuid from vars where k = 'acme'), 'dave@example.com', 'viewer');

select is(
  (select count(*) from public.workspace_invitations where workspace_id = (select v::uuid from vars where k = 'acme')),
  3::bigint, 'admins can read their workspace invitations');

select is(
  (select email from public.workspace_invitations where role = 'member'),
  'bob@example.com', 'invitation emails are normalised');

select ok(
  (select token_hash <> convert_to((select v from vars where k = 'bob_token'), 'UTF8')
   from public.workspace_invitations where email = 'bob@example.com'),
  'raw invitation tokens are not stored');

select throws_ok(
  $$select private.write_audit(null, 'forged.event')$$,
  '42501', null, 'clients cannot write audit entries directly');

select throws_ok(
  $$insert into public.audit_logs (action) values ('forged.event')$$,
  '42501', null, 'clients cannot insert audit rows');

-- -----------------------------------------------------------------------------
-- Bob: invitation acceptance and member restrictions
-- -----------------------------------------------------------------------------
select pg_temp.login('22222222-2222-2222-2222-222222222222');

select is((select count(*) from public.workspaces where name = 'Acme Ltd'), 0::bigint,
  'bob cannot see Acme before accepting');

select throws_ok(
  $$select public.accept_workspace_invitation((select v from vars where k = 'eve_token'))$$,
  'P0002', null, 'an invitation addressed to someone else is rejected');

select is(
  public.accept_workspace_invitation((select v from vars where k = 'bob_token')),
  (select v::uuid from vars where k = 'acme'), 'bob accepts his invitation');

select is((select count(*) from public.workspaces where name = 'Acme Ltd'), 1::bigint,
  'bob sees Acme after accepting');

select throws_ok(
  $$select public.accept_workspace_invitation((select v from vars where k = 'bob_token'))$$,
  'P0002', null, 'an invitation cannot be reused');

select is(
  (select display_name from public.profiles where id = '11111111-1111-1111-1111-111111111111'),
  'Alice', 'co-members can read each other''s profiles');

with u as (update public.workspaces set name = 'Hijacked' where name = 'Acme Ltd' returning 1)
select is(count(*), 0::bigint, 'members cannot rename the workspace') from u;

select throws_ok(
  $$select public.create_workspace_invitation((select v::uuid from vars where k = 'acme'), 'x@example.com', 'member')$$,
  '42501', null, 'members cannot invite');

select is((select count(*) from public.workspace_invitations), 0::bigint, 'members cannot read invitations');

select is(
  (select count(*) from public.audit_logs where action = 'workspace.created'),
  0::bigint, 'members cannot read workspace audit events');

select throws_ok(
  $$update public.workspace_members set role = 'owner' where user_id = '22222222-2222-2222-2222-222222222222'$$,
  '42501', null, 'members cannot edit their own role directly');

-- -----------------------------------------------------------------------------
-- Role management
-- -----------------------------------------------------------------------------
select pg_temp.login('11111111-1111-1111-1111-111111111111');
select lives_ok(
  $$select public.set_workspace_member_role((select v::uuid from vars where k = 'acme'),
      '22222222-2222-2222-2222-222222222222', 'admin')$$,
  'the owner can promote a member to admin');

select pg_temp.login('22222222-2222-2222-2222-222222222222');
select throws_ok(
  $$select public.set_workspace_member_role((select v::uuid from vars where k = 'acme'),
      '11111111-1111-1111-1111-111111111111', 'viewer')$$,
  '42501', null, 'an admin cannot demote the owner');

with d as (delete from public.workspace_members where user_id = '11111111-1111-1111-1111-111111111111' returning 1)
select is(count(*), 0::bigint, 'an admin cannot remove the owner') from d;

with d as (delete from public.workspaces where name = 'Acme Ltd' returning 1)
select is(count(*), 0::bigint, 'an admin cannot delete the workspace') from d;

-- -----------------------------------------------------------------------------
-- Carol: complete outsider
-- -----------------------------------------------------------------------------
select pg_temp.login('33333333-3333-3333-3333-333333333333');

select is(
  (select count(*) from public.workspaces where owner_id <> '33333333-3333-3333-3333-333333333333'),
  0::bigint, 'an outsider sees no other workspaces');

select is(
  (select count(*) from public.profiles where id <> '33333333-3333-3333-3333-333333333333'),
  0::bigint, 'an outsider sees no other profiles');

select is((select count(*) from public.workspace_members where workspace_id = (select v::uuid from vars where k = 'acme')),
  0::bigint, 'an outsider cannot list members');

select throws_ok(
  $$insert into public.workspace_members (workspace_id, user_id, role)
    values ((select v::uuid from vars where k = 'acme'), '33333333-3333-3333-3333-333333333333', 'owner')$$,
  '42501', null, 'an outsider cannot add themselves to a workspace');

select throws_ok(
  $$insert into public.workspaces (type, name, owner_id)
    values ('business', 'Sneaky', '11111111-1111-1111-1111-111111111111')$$,
  '42501', null, 'workspaces cannot be inserted directly');

select throws_ok(
  $$select public.revoke_workspace_invitation((select id from public.workspace_invitations limit 1))$$,
  '42501', null, 'an outsider cannot revoke invitations');

-- -----------------------------------------------------------------------------
-- Dave: unconfirmed email
-- -----------------------------------------------------------------------------
select pg_temp.login('44444444-4444-4444-4444-444444444444');
select throws_ok(
  $$select public.accept_workspace_invitation((select v from vars where k = 'dave_token'))$$,
  'P0002', null, 'an unconfirmed email cannot accept invitations');

-- -----------------------------------------------------------------------------
-- Audit log is append-only, even for the database owner
-- -----------------------------------------------------------------------------
reset role;

select is(
  (select count(*) from public.audit_logs
   where workspace_id = (select v::uuid from vars where k = 'acme')
     and action in ('workspace.created', 'invitation.created', 'invitation.accepted', 'member.role_changed')),
  6::bigint, 'privileged actions are audited');

select throws_ok($$update public.audit_logs set action = 'tampered.event'$$, '42501', null,
  'audit rows cannot be updated');
select throws_ok($$delete from public.audit_logs$$, '42501', null, 'audit rows cannot be deleted');

-- Deleting a workspace or a user must not touch audit history.
select lives_ok(
  $$delete from public.workspaces where name = 'Acme Ltd'$$,
  'a workspace with audit history can be deleted');
select lives_ok(
  $$delete from auth.users where id = '22222222-2222-2222-2222-222222222222'$$,
  'a user with audit history can be deleted');
select is(
  (select count(*) from public.audit_logs where workspace_id = (select v::uuid from vars where k = 'acme')),
  7::bigint, 'audit history survives deletion of the workspace and its members');

select * from finish();
rollback;
