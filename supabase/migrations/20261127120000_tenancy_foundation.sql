-- =============================================================================
-- Milestone 1.1 — Tenancy foundation
--
-- Profiles, personal/business workspaces, membership roles, invitations and an
-- append-only audit log. Every table has row-level security enabled; clients
-- (anon / authenticated) can only do what an explicit policy or a SECURITY
-- DEFINER function allows. Privileged multi-step operations (create workspace,
-- invite, accept, change role) are database functions so the checks and the
-- writes happen atomically in one place.
--
-- Conventions:
--   * Helpers used by RLS policies live in the `private` schema, which is not
--     exposed through the Data API.
--   * Every SECURITY DEFINER function pins `search_path = ''` and fully
--     qualifies every object, so callers cannot hijack name resolution.
--   * `workspace_role` enum order is owner < admin < member < viewer, so
--     `role <= 'admin'` means "admin or more privileged".
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Types
-- -----------------------------------------------------------------------------

create type public.workspace_type as enum ('personal', 'business');
create type public.workspace_role as enum ('owner', 'admin', 'member', 'viewer');

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 100),
  avatar_url text check (char_length(avatar_url) <= 2048 and avatar_url ~ '^https://'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.profiles is 'Public profile for each auth user; created automatically at sign-up.';

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  type public.workspace_type not null,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  owner_id uuid not null references auth.users (id) on delete cascade,
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.workspaces is 'Tenant boundary. Every tenant-owned row references a workspace.';

create unique index workspaces_one_personal_per_user
  on public.workspaces (owner_id)
  where type = 'personal';

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.workspace_role not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_id_idx on public.workspace_members (user_id);

-- Exactly one owner per workspace, enforced by the database.
create unique index workspace_members_one_owner
  on public.workspace_members (workspace_id)
  where role = 'owner';

create table public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role public.workspace_role not null check (role <> 'owner'),
  -- Only a SHA-256 hash of the token is stored; the raw token is returned once.
  token_hash bytea not null unique,
  invited_by uuid references auth.users (id) on delete set null,
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index workspace_invitations_workspace_id_idx on public.workspace_invitations (workspace_id);

-- At most one open invitation per email per workspace.
create unique index workspace_invitations_one_pending
  on public.workspace_invitations (workspace_id, email)
  where accepted_at is null and revoked_at is null;

-- workspace_id / actor_id deliberately have no foreign keys: audit history must
-- outlive the workspaces and users it describes, and rows can never be modified.
create table public.audit_logs (
  id bigint generated always as identity primary key,
  workspace_id uuid,
  actor_id uuid,
  action text not null check (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_workspace_created_idx on public.audit_logs (workspace_id, created_at desc);
create index audit_logs_actor_created_idx on public.audit_logs (actor_id, created_at desc);
comment on table public.audit_logs is 'Append-only. Rows are written by database functions only and can never be updated or deleted.';

-- -----------------------------------------------------------------------------
-- Generic triggers
-- -----------------------------------------------------------------------------

create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function private.set_updated_at();
create trigger workspaces_set_updated_at before update on public.workspaces
  for each row execute function private.set_updated_at();
create trigger workspace_members_set_updated_at before update on public.workspace_members
  for each row execute function private.set_updated_at();

create function private.prevent_audit_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_logs is append-only' using errcode = '42501';
end;
$$;

create trigger audit_logs_append_only
  before update or delete on public.audit_logs
  for each row execute function private.prevent_audit_mutation();

create trigger audit_logs_no_truncate
  before truncate on public.audit_logs
  for each statement execute function private.prevent_audit_mutation();

-- -----------------------------------------------------------------------------
-- Private helpers (used by policies and functions)
-- -----------------------------------------------------------------------------

-- True when the current user holds `min_role` or a more privileged role.
create function private.has_workspace_role(p_workspace_id uuid, p_min_role public.workspace_role)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = p_workspace_id
      and m.user_id = (select auth.uid())
      and m.role <= p_min_role
  );
$$;

-- True when the current user shares at least one workspace with `p_user_id`.
create function private.shares_workspace_with(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members mine
    join public.workspace_members theirs on theirs.workspace_id = mine.workspace_id
    where mine.user_id = (select auth.uid())
      and theirs.user_id = p_user_id
  );
$$;

create function private.write_audit(
  p_workspace_id uuid,
  p_action text,
  p_target_type text default null,
  p_target_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_logs (workspace_id, actor_id, action, target_type, target_id, metadata)
  values (p_workspace_id, (select auth.uid()), p_action, p_target_type, p_target_id, coalesce(p_metadata, '{}'::jsonb));
$$;

create function private.require_user()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  return v_uid;
end;
$$;

revoke all on all functions in schema private from public, anon;
grant execute on function private.has_workspace_role(uuid, public.workspace_role) to authenticated;
grant execute on function private.shares_workspace_with(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Sign-up: profile + personal workspace
-- -----------------------------------------------------------------------------

create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_display_name text := left(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), 100);
begin
  insert into public.profiles (id, display_name) values (new.id, v_display_name);

  insert into public.workspaces (type, name, owner_id)
  values ('personal', 'Personal', new.id)
  returning id into v_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_workspace_id, new.id, 'owner');

  insert into public.audit_logs (workspace_id, actor_id, action, target_type, target_id)
  values (v_workspace_id, new.id, 'user.signed_up', 'user', new.id::text);

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invitations enable row level security;
alter table public.audit_logs enable row level security;

-- Defence in depth: anonymous clients get no table access at all, and
-- authenticated clients get only the privileges their policies need.
revoke all on public.profiles, public.workspaces, public.workspace_members,
  public.workspace_invitations, public.audit_logs from anon, authenticated;

grant select on public.profiles, public.workspaces, public.workspace_members,
  public.workspace_invitations, public.audit_logs to authenticated;
grant update (display_name, avatar_url) on public.profiles to authenticated;
grant update (name, settings) on public.workspaces to authenticated;
grant delete on public.workspaces, public.workspace_members to authenticated;

-- profiles
create policy "profiles: read own or co-members"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()) or private.shares_workspace_with(id));

create policy "profiles: update own"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- workspaces
create policy "workspaces: members can read"
  on public.workspaces for select to authenticated
  using (private.has_workspace_role(id, 'viewer'));

create policy "workspaces: admins can update"
  on public.workspaces for update to authenticated
  using (private.has_workspace_role(id, 'admin'))
  with check (private.has_workspace_role(id, 'admin'));

create policy "workspaces: owner can delete business workspaces"
  on public.workspaces for delete to authenticated
  using (type = 'business' and owner_id = (select auth.uid()));

-- workspace_members
create policy "members: co-members can read"
  on public.workspace_members for select to authenticated
  using (private.has_workspace_role(workspace_id, 'viewer'));

create policy "members: leave or remove"
  on public.workspace_members for delete to authenticated
  using (
    role <> 'owner'
    and (
      user_id = (select auth.uid())
      or private.has_workspace_role(workspace_id, 'owner')
      or (private.has_workspace_role(workspace_id, 'admin') and role in ('member', 'viewer'))
    )
  );

-- workspace_invitations (writes go through functions below)
create policy "invitations: admins can read"
  on public.workspace_invitations for select to authenticated
  using (private.has_workspace_role(workspace_id, 'admin'));

-- audit_logs (writes go through functions; never updated or deleted)
create policy "audit: admins read workspace events, users read their own"
  on public.audit_logs for select to authenticated
  using (
    (workspace_id is not null and private.has_workspace_role(workspace_id, 'admin'))
    or actor_id = (select auth.uid())
  );

-- -----------------------------------------------------------------------------
-- Audit triggers for direct (policy-permitted) writes
-- -----------------------------------------------------------------------------

create function private.audit_workspace_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    perform private.write_audit(new.id, 'workspace.updated', 'workspace', new.id::text,
      jsonb_build_object('name_changed', old.name is distinct from new.name,
                         'settings_changed', old.settings is distinct from new.settings));
    return new;
  end if;
  perform private.write_audit(old.id, 'workspace.deleted', 'workspace', old.id::text,
    jsonb_build_object('name', old.name));
  return old;
end;
$$;

create trigger workspaces_audit
  after update or delete on public.workspaces
  for each row execute function private.audit_workspace_change();

create function private.audit_member_removed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Skip cascaded deletes from a workspace being removed.
  if exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
    perform private.write_audit(old.workspace_id,
      case when old.user_id = (select auth.uid()) then 'member.left' else 'member.removed' end,
      'user', old.user_id::text, jsonb_build_object('role', old.role));
  end if;
  return old;
end;
$$;

create trigger workspace_members_audit_delete
  after delete on public.workspace_members
  for each row execute function private.audit_member_removed();

revoke all on function private.audit_workspace_change() from public, anon, authenticated;
revoke all on function private.audit_member_removed() from public, anon, authenticated;
revoke all on function private.handle_new_user() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Public API functions (callable by authenticated users via RPC)
-- -----------------------------------------------------------------------------

create function public.create_business_workspace(p_name text)
returns public.workspaces
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_workspace public.workspaces;
begin
  if (select count(*) from public.workspaces w where w.owner_id = v_uid and w.type = 'business') >= 20 then
    raise exception 'business workspace limit reached' using errcode = 'P0001';
  end if;

  insert into public.workspaces (type, name, owner_id)
  values ('business', btrim(p_name), v_uid)
  returning * into v_workspace;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_workspace.id, v_uid, 'owner');

  perform private.write_audit(v_workspace.id, 'workspace.created', 'workspace', v_workspace.id::text);
  return v_workspace;
end;
$$;

-- Returns the raw invitation token exactly once; only its hash is stored.
create function public.create_workspace_invitation(
  p_workspace_id uuid,
  p_email text,
  p_role public.workspace_role
)
returns table (invitation_id uuid, token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_email text := lower(btrim(p_email));
  v_type public.workspace_type;
begin
  select w.type into v_type from public.workspaces w where w.id = p_workspace_id;
  if v_type is null or not private.has_workspace_role(p_workspace_id, 'admin') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_type = 'personal' then
    raise exception 'personal workspaces cannot have other members' using errcode = 'P0001';
  end if;
  if p_role = 'owner' then
    raise exception 'cannot invite an owner' using errcode = 'P0001';
  end if;
  if p_role = 'admin' and not private.has_workspace_role(p_workspace_id, 'owner') then
    raise exception 'only the owner can invite admins' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.workspace_members m
    join auth.users u on u.id = m.user_id
    where m.workspace_id = p_workspace_id and lower(u.email) = v_email
  ) then
    raise exception 'user is already a member' using errcode = '23505';
  end if;

  return query
  insert into public.workspace_invitations (workspace_id, email, role, token_hash, invited_by)
  values (p_workspace_id, v_email, p_role, extensions.digest(v_token, 'sha256'), v_uid)
  returning workspace_invitations.id, v_token, workspace_invitations.expires_at;

  perform private.write_audit(p_workspace_id, 'invitation.created', 'invitation', null,
    jsonb_build_object('email', v_email, 'role', p_role));
end;
$$;

create function public.revoke_workspace_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
begin
  perform private.require_user();
  select i.workspace_id into v_workspace_id
  from public.workspace_invitations i
  where i.id = p_invitation_id and i.accepted_at is null and i.revoked_at is null;

  if v_workspace_id is null or not private.has_workspace_role(v_workspace_id, 'admin') then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  update public.workspace_invitations set revoked_at = now() where id = p_invitation_id;
  perform private.write_audit(v_workspace_id, 'invitation.revoked', 'invitation', p_invitation_id::text);
end;
$$;

-- The invitation must be addressed to the caller's verified email address.
create function public.accept_workspace_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_invitation public.workspace_invitations;
  v_email text;
  v_confirmed timestamptz;
begin
  select u.email, u.email_confirmed_at into v_email, v_confirmed from auth.users u where u.id = v_uid;

  select * into v_invitation
  from public.workspace_invitations i
  where i.token_hash = extensions.digest(coalesce(p_token, ''), 'sha256')
  for update;

  -- One generic error for every failure so tokens cannot be probed.
  if v_invitation.id is null
     or v_invitation.accepted_at is not null
     or v_invitation.revoked_at is not null
     or v_invitation.expires_at <= now()
     or v_confirmed is null
     or lower(v_email) <> v_invitation.email then
    raise exception 'invitation is invalid or expired' using errcode = 'P0002';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_invitation.workspace_id, v_uid, v_invitation.role)
  on conflict (workspace_id, user_id) do nothing;

  update public.workspace_invitations
  set accepted_at = now(), accepted_by = v_uid
  where id = v_invitation.id;

  perform private.write_audit(v_invitation.workspace_id, 'invitation.accepted', 'invitation',
    v_invitation.id::text, jsonb_build_object('role', v_invitation.role));
  return v_invitation.workspace_id;
end;
$$;

create function public.set_workspace_member_role(
  p_workspace_id uuid,
  p_user_id uuid,
  p_role public.workspace_role
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current public.workspace_role;
begin
  perform private.require_user();
  select m.role into v_current
  from public.workspace_members m
  where m.workspace_id = p_workspace_id and m.user_id = p_user_id;

  if v_current is null or not private.has_workspace_role(p_workspace_id, 'admin') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_current = 'owner' or p_role = 'owner' then
    raise exception 'ownership cannot be changed here' using errcode = '42501';
  end if;
  -- Admins may only manage members and viewers; the owner manages admins.
  if not private.has_workspace_role(p_workspace_id, 'owner')
     and (v_current = 'admin' or p_role = 'admin') then
    raise exception 'only the owner can manage admins' using errcode = '42501';
  end if;

  update public.workspace_members
  set role = p_role
  where workspace_id = p_workspace_id and user_id = p_user_id;

  perform private.write_audit(p_workspace_id, 'member.role_changed', 'user', p_user_id::text,
    jsonb_build_object('from', v_current, 'to', p_role));
end;
$$;

revoke all on function public.create_business_workspace(text) from public, anon;
revoke all on function public.create_workspace_invitation(uuid, text, public.workspace_role) from public, anon;
revoke all on function public.revoke_workspace_invitation(uuid) from public, anon;
revoke all on function public.accept_workspace_invitation(text) from public, anon;
revoke all on function public.set_workspace_member_role(uuid, uuid, public.workspace_role) from public, anon;

grant execute on function public.create_business_workspace(text) to authenticated;
grant execute on function public.create_workspace_invitation(uuid, text, public.workspace_role) to authenticated;
grant execute on function public.revoke_workspace_invitation(uuid) to authenticated;
grant execute on function public.accept_workspace_invitation(text) to authenticated;
grant execute on function public.set_workspace_member_role(uuid, uuid, public.workspace_role) to authenticated;
