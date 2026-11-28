-- =============================================================================
-- Phase 2B — outreach campaigns.
--
-- A campaign targets a kind of business in an area with an offer. Its leads
-- are clients (found on Google Maps or already in the CRM). Sir Libz drafts a
-- personal message per lead; a member sends it themselves (their own WhatsApp,
-- email or phone) and marks it sent, which logs an activity and schedules a
-- follow-up. Nothing is ever sent automatically. Do-not-contact is respected.
-- =============================================================================

alter table public.companies add column do_not_contact boolean not null default false;
grant update (do_not_contact) on public.companies to authenticated;

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  target_what text check (char_length(target_what) <= 100),
  target_where text check (char_length(target_where) <= 100),
  offer text not null check (char_length(btrim(offer)) between 1 and 2000),
  channel text not null default 'whatsapp' check (channel in ('whatsapp', 'email', 'call')),
  status text not null default 'active' check (status in ('active', 'paused', 'done')),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index campaigns_workspace_idx on public.campaigns (workspace_id, created_at desc);

create table public.campaign_leads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete set null,
  status text not null default 'to_contact'
    check (status in ('to_contact', 'drafted', 'sent', 'replied', 'interested', 'not_interested', 'won')),
  message text check (char_length(message) <= 2000),
  sent_at timestamptz,
  sent_via text check (sent_via in ('whatsapp', 'email', 'call')),
  follow_up_at timestamptz,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, company_id)
);
create index campaign_leads_campaign_idx on public.campaign_leads (campaign_id, status);
create index campaign_leads_company_idx on public.campaign_leads (company_id);

create trigger campaigns_set_updated_at before update on public.campaigns
  for each row execute function private.set_updated_at();
create trigger campaign_leads_set_updated_at before update on public.campaign_leads
  for each row execute function private.set_updated_at();
create trigger campaigns_business_only before insert on public.campaigns
  for each row execute function private.require_business_workspace();
create trigger campaign_leads_same_workspace before insert or update on public.campaign_leads
  for each row execute function private.check_same_workspace();

-- The lead's campaign must belong to the same workspace too.
create function private.check_campaign_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.campaigns c where c.id = new.campaign_id and c.workspace_id = new.workspace_id
  ) then
    raise exception 'campaign not found in this workspace' using errcode = 'P0002';
  end if;
  return new;
end;
$$;
revoke all on function private.check_campaign_workspace() from public, anon, authenticated;
create trigger campaign_leads_campaign_workspace before insert or update on public.campaign_leads
  for each row execute function private.check_campaign_workspace();

-- Audit without content.
create function private.audit_outreach()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'campaigns' then
    if tg_op = 'INSERT' then
      perform private.write_audit(new.workspace_id, 'campaign.created', 'campaign', new.id::text);
    end if;
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status and new.status = 'sent' then
    perform private.write_audit(new.workspace_id, 'outreach.sent', 'campaign_lead', new.id::text,
      jsonb_build_object('via', new.sent_via, 'campaign_id', new.campaign_id));
  end if;
  return new;
end;
$$;
revoke all on function private.audit_outreach() from public, anon, authenticated;
create trigger campaigns_audit after insert on public.campaigns
  for each row execute function private.audit_outreach();
create trigger campaign_leads_audit after update on public.campaign_leads
  for each row execute function private.audit_outreach();

do $$
declare
  t text;
begin
  foreach t in array array['campaigns', 'campaign_leads'] loop
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
    execute format(
      'create policy "%1$s: members delete" on public.%1$I for delete to authenticated
         using (private.has_workspace_role(workspace_id, ''member''))', t);
  end loop;
end;
$$;

grant update (name, target_what, target_where, offer, channel, status) on public.campaigns to authenticated;
grant update (contact_id, status, message, sent_at, sent_via, follow_up_at) on public.campaign_leads to authenticated;

-- AI usage outside chat (e.g. drafting outreach) is recorded against the
-- same daily token budget.
create function public.record_ai_usage(p_workspace_id uuid, p_provider text, p_model text, p_input_tokens integer, p_output_tokens integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := private.require_user();
begin
  if not private.has_workspace_role(p_workspace_id, 'member') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into public.ai_usage (workspace_id, user_id, provider, model, input_tokens, output_tokens)
  values (p_workspace_id, v_user, left(p_provider, 50), left(p_model, 200),
          greatest(p_input_tokens, 0), greatest(p_output_tokens, 0));
end;
$$;
revoke all on function public.record_ai_usage(uuid, text, text, integer, integer) from public, anon;
grant execute on function public.record_ai_usage(uuid, text, text, integer, integer) to authenticated;
