-- =============================================================================
-- Phase 1A — Libz business core: companies, contacts, deals, projects, tasks,
-- activities.
--
-- * CRM records are shared with every member of a BUSINESS workspace
--   (viewers read, members write, admins delete). Tasks also exist in
--   personal workspaces.
-- * Every reference (company, contact, deal, project, assignee, owner) must
--   belong to the same workspace — enforced in the database.
-- * Contacts carry marketing consent and do-not-contact flags so future
--   outreach can respect them.
-- * Changes are audited without content.
-- =============================================================================

create type public.deal_stage as enum
  ('lead', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost');
create type public.consent_status as enum ('unknown', 'granted', 'denied');
create type public.task_status as enum ('open', 'in_progress', 'done', 'cancelled');
create type public.task_priority as enum ('low', 'normal', 'high', 'urgent');
create type public.project_status as enum ('planned', 'active', 'on_hold', 'done', 'cancelled');
create type public.activity_type as enum ('note', 'call', 'email', 'whatsapp', 'meeting');

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  industry text check (char_length(industry) <= 100),
  website text check (char_length(website) <= 500 and website ~* '^https?://'),
  phone_e164 text check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  email text check (email = lower(btrim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  address text check (char_length(address) <= 500),
  city text check (char_length(city) <= 100),
  country text check (char_length(country) <= 100),
  source text not null default 'manual'
    check (source in ('manual', 'import', 'referral', 'website', 'event', 'other')),
  notes text check (char_length(notes) <= 5000),
  tags text[] not null default '{}' check (cardinality(tags) <= 20),
  attributes jsonb not null default '{}'::jsonb check (jsonb_typeof(attributes) = 'object'),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index companies_workspace_name_idx on public.companies (workspace_id, lower(name));
create unique index companies_unique_email on public.companies (workspace_id, email) where email is not null;
create unique index companies_unique_phone on public.companies (workspace_id, phone_e164) where phone_e164 is not null;

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  company_id uuid references public.companies (id) on delete set null,
  full_name text not null check (char_length(btrim(full_name)) between 1 and 200),
  role_title text check (char_length(role_title) <= 100),
  phone_e164 text check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  email text check (email = lower(btrim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  marketing_consent public.consent_status not null default 'unknown',
  consent_source text check (char_length(consent_source) <= 200),
  consent_at timestamptz,
  do_not_contact boolean not null default false,
  notes text check (char_length(notes) <= 5000),
  tags text[] not null default '{}' check (cardinality(tags) <= 20),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Consent must say when and how it was given.
  check (marketing_consent <> 'granted' or (consent_at is not null and consent_source is not null))
);
create index contacts_workspace_name_idx on public.contacts (workspace_id, lower(full_name));
create index contacts_company_idx on public.contacts (company_id);
create unique index contacts_unique_email on public.contacts (workspace_id, email) where email is not null;
create unique index contacts_unique_phone on public.contacts (workspace_id, phone_e164) where phone_e164 is not null;

create table public.deals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete set null,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  stage public.deal_stage not null default 'lead',
  value numeric(14, 2) not null default 0 check (value >= 0),
  currency text not null default 'USD' check (currency in ('USD', 'ZWG', 'ZAR', 'GBP', 'EUR')),
  expected_close date,
  owner_id uuid default auth.uid() references auth.users (id) on delete set null,
  lost_reason text check (char_length(lost_reason) <= 500),
  stage_changed_at timestamptz not null default now(),
  closed_at timestamptz,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index deals_workspace_stage_idx on public.deals (workspace_id, stage);
create index deals_company_idx on public.deals (company_id);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  deal_id uuid references public.deals (id) on delete set null,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  status public.project_status not null default 'planned',
  description text check (char_length(description) <= 5000),
  start_date date,
  end_date date,
  budget numeric(14, 2) check (budget >= 0),
  currency text not null default 'USD' check (currency in ('USD', 'ZWG', 'ZAR', 'GBP', 'EUR')),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date)
);
create index projects_workspace_status_idx on public.projects (workspace_id, status);
create index projects_company_idx on public.projects (company_id);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 300),
  notes text check (char_length(notes) <= 5000),
  due_at timestamptz,
  status public.task_status not null default 'open',
  priority public.task_priority not null default 'normal',
  assignee_id uuid default auth.uid() references auth.users (id) on delete set null,
  company_id uuid references public.companies (id) on delete set null,
  contact_id uuid references public.contacts (id) on delete set null,
  deal_id uuid references public.deals (id) on delete set null,
  project_id uuid references public.projects (id) on delete set null,
  completed_at timestamptz,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tasks_workspace_status_due_idx on public.tasks (workspace_id, status, due_at);
create index tasks_assignee_idx on public.tasks (assignee_id, status);

create table public.activities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  type public.activity_type not null,
  direction text not null default 'internal' check (direction in ('inbound', 'outbound', 'internal')),
  summary text not null check (char_length(btrim(summary)) between 1 and 5000),
  occurred_at timestamptz not null default now(),
  company_id uuid references public.companies (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete set null,
  deal_id uuid references public.deals (id) on delete set null,
  project_id uuid references public.projects (id) on delete set null,
  source text not null default 'manual' check (source in ('manual', 'jarvis', 'import')),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index activities_workspace_time_idx on public.activities (workspace_id, occurred_at desc);
create index activities_company_idx on public.activities (company_id, occurred_at desc);

-- -----------------------------------------------------------------------------
-- Integrity triggers
-- -----------------------------------------------------------------------------

create trigger companies_set_updated_at before update on public.companies
  for each row execute function private.set_updated_at();
create trigger contacts_set_updated_at before update on public.contacts
  for each row execute function private.set_updated_at();
create trigger deals_set_updated_at before update on public.deals
  for each row execute function private.set_updated_at();
create trigger projects_set_updated_at before update on public.projects
  for each row execute function private.set_updated_at();
create trigger tasks_set_updated_at before update on public.tasks
  for each row execute function private.set_updated_at();

-- CRM records exist only in business workspaces.
create function private.require_business_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select w.type from public.workspaces w where w.id = new.workspace_id) is distinct from 'business' then
    raise exception 'this is only available in business workspaces' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Every reference must point into the same workspace; people must be members.
create function private.check_same_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r jsonb := to_jsonb(new);
begin
  if r ? 'company_id' and r ->> 'company_id' is not null and not exists (
    select 1 from public.companies x where x.id = (r ->> 'company_id')::uuid and x.workspace_id = new.workspace_id
  ) then
    raise exception 'company not found in this workspace' using errcode = 'P0002';
  end if;
  if r ? 'contact_id' and r ->> 'contact_id' is not null and not exists (
    select 1 from public.contacts x where x.id = (r ->> 'contact_id')::uuid and x.workspace_id = new.workspace_id
  ) then
    raise exception 'contact not found in this workspace' using errcode = 'P0002';
  end if;
  if r ? 'deal_id' and r ->> 'deal_id' is not null and not exists (
    select 1 from public.deals x where x.id = (r ->> 'deal_id')::uuid and x.workspace_id = new.workspace_id
  ) then
    raise exception 'deal not found in this workspace' using errcode = 'P0002';
  end if;
  if r ? 'project_id' and r ->> 'project_id' is not null and not exists (
    select 1 from public.projects x where x.id = (r ->> 'project_id')::uuid and x.workspace_id = new.workspace_id
  ) then
    raise exception 'project not found in this workspace' using errcode = 'P0002';
  end if;
  if r ? 'assignee_id' and r ->> 'assignee_id' is not null and not exists (
    select 1 from public.workspace_members m
    where m.workspace_id = new.workspace_id and m.user_id = (r ->> 'assignee_id')::uuid
  ) then
    raise exception 'assignee is not a member of this workspace' using errcode = 'P0001';
  end if;
  if r ? 'owner_id' and r ->> 'owner_id' is not null and not exists (
    select 1 from public.workspace_members m
    where m.workspace_id = new.workspace_id and m.user_id = (r ->> 'owner_id')::uuid
  ) then
    raise exception 'owner is not a member of this workspace' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['companies', 'contacts', 'deals', 'projects', 'activities'] loop
    execute format(
      'create trigger %1$s_business_only before insert on public.%1$s
         for each row execute function private.require_business_workspace()', t);
  end loop;
  foreach t in array array['contacts', 'deals', 'projects', 'tasks', 'activities'] loop
    execute format(
      'create trigger %1$s_same_workspace before insert or update on public.%1$s
         for each row execute function private.check_same_workspace()', t);
  end loop;
end;
$$;

-- Keep stage/close and completion timestamps truthful.
create function private.deal_stage_tracking()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.stage is distinct from old.stage then
    new.stage_changed_at := now();
  end if;
  if new.stage in ('won', 'lost') then
    new.closed_at := coalesce(case when tg_op = 'UPDATE' and old.stage = new.stage then old.closed_at end, now());
  else
    new.closed_at := null;
  end if;
  return new;
end;
$$;

create trigger deals_stage_tracking before insert or update on public.deals
  for each row execute function private.deal_stage_tracking();

create function private.task_completion_tracking()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'done' then
    new.completed_at := coalesce(case when tg_op = 'UPDATE' and old.status = 'done' then old.completed_at end, now());
  else
    new.completed_at := null;
  end if;
  return new;
end;
$$;

create trigger tasks_completion_tracking before insert or update on public.tasks
  for each row execute function private.task_completion_tracking();

-- Audit without content (deal stage moves record from/to).
create function private.audit_business()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  entity text := case tg_table_name
    when 'companies' then 'company' when 'contacts' then 'contact' when 'deals' then 'deal'
    when 'projects' then 'project' when 'tasks' then 'task' else 'activity' end;
begin
  if tg_op = 'INSERT' then
    perform private.write_audit(new.workspace_id, entity || '.created', entity, new.id::text);
    return new;
  elsif tg_op = 'UPDATE' then
    -- Read table-specific fields via jsonb: PL/pgSQL does not short-circuit
    -- record field access, so `new.stage` would fail on tables without it.
    if tg_table_name = 'deals'
       and to_jsonb(new) ->> 'stage' is distinct from to_jsonb(old) ->> 'stage' then
      perform private.write_audit(new.workspace_id, 'deal.stage_changed', 'deal', new.id::text,
        jsonb_build_object('from', to_jsonb(old) ->> 'stage', 'to', to_jsonb(new) ->> 'stage'));
    elsif tg_table_name = 'tasks'
       and to_jsonb(new) ->> 'status' = 'done' and to_jsonb(old) ->> 'status' <> 'done' then
      perform private.write_audit(new.workspace_id, 'task.completed', 'task', new.id::text);
    end if;
    return new;
  end if;
  if exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
    perform private.write_audit(old.workspace_id, entity || '.deleted', entity, old.id::text);
  end if;
  return old;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['companies', 'contacts', 'deals', 'projects', 'tasks', 'activities'] loop
    execute format(
      'create trigger %1$s_audit after insert or update or delete on public.%1$s
         for each row execute function private.audit_business()', t);
  end loop;
end;
$$;

revoke all on function private.require_business_workspace() from public, anon, authenticated;
revoke all on function private.check_same_workspace() from public, anon, authenticated;
revoke all on function private.deal_stage_tracking() from public, anon, authenticated;
revoke all on function private.task_completion_tracking() from public, anon, authenticated;
revoke all on function private.audit_business() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Row-level security: viewers read, members write, admins delete
-- (task authors may also delete their own tasks).
-- -----------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['companies', 'contacts', 'deals', 'projects', 'tasks', 'activities'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, delete on public.%I to authenticated', t);
    execute format(
      'create policy "%1$s: members read" on public.%1$I for select to authenticated
         using (private.has_workspace_role(workspace_id, ''viewer''))', t);
    execute format(
      'create policy "%1$s: members create" on public.%1$I for insert to authenticated
         with check (private.has_workspace_role(workspace_id, ''member'') and created_by = (select auth.uid()))', t);
    execute format(
      'create policy "%1$s: members update" on public.%1$I for update to authenticated
         using (private.has_workspace_role(workspace_id, ''member''))
         with check (private.has_workspace_role(workspace_id, ''member''))', t);
  end loop;
end;
$$;

create policy "companies: admins delete" on public.companies for delete to authenticated
  using (private.has_workspace_role(workspace_id, 'admin'));
create policy "contacts: admins delete" on public.contacts for delete to authenticated
  using (private.has_workspace_role(workspace_id, 'admin'));
create policy "deals: admins delete" on public.deals for delete to authenticated
  using (private.has_workspace_role(workspace_id, 'admin'));
create policy "projects: admins delete" on public.projects for delete to authenticated
  using (private.has_workspace_role(workspace_id, 'admin'));
create policy "activities: admins delete" on public.activities for delete to authenticated
  using (private.has_workspace_role(workspace_id, 'admin'));
create policy "tasks: author or admin deletes" on public.tasks for delete to authenticated
  using (
    private.has_workspace_role(workspace_id, 'admin')
    or (created_by = (select auth.uid()) and private.has_workspace_role(workspace_id, 'member'))
  );

-- Updatable columns only (never workspace_id, created_by or timestamps).
grant update (name, industry, website, phone_e164, email, address, city, country, source, notes, tags, attributes)
  on public.companies to authenticated;
grant update (company_id, full_name, role_title, phone_e164, email, marketing_consent, consent_source,
  consent_at, do_not_contact, notes, tags)
  on public.contacts to authenticated;
grant update (company_id, contact_id, title, stage, value, currency, expected_close, owner_id, lost_reason)
  on public.deals to authenticated;
grant update (company_id, deal_id, name, status, description, start_date, end_date, budget, currency)
  on public.projects to authenticated;
grant update (title, notes, due_at, status, priority, assignee_id, company_id, contact_id, deal_id, project_id)
  on public.tasks to authenticated;
grant update (type, direction, summary, occurred_at, company_id, contact_id, deal_id, project_id)
  on public.activities to authenticated;
