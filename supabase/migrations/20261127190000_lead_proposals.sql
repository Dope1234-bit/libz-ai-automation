-- =============================================================================
-- Phase 2A — Sir Libz can suggest Google Maps businesses as leads.
--
-- A 'lead' proposal holds details the server fetched from Google Maps. Like
-- every proposal it creates nothing until the user confirms; confirming adds
-- the client (source google_maps) and a lead deal in one transaction.
-- =============================================================================

alter table public.ai_proposals drop constraint ai_proposals_kind_check;
alter table public.ai_proposals add constraint ai_proposals_kind_check
  check (kind in ('task', 'activity_note', 'lead'));

create or replace function public.decide_ai_proposal(p_proposal_id uuid, p_confirm boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := private.require_user();
  p public.ai_proposals;
  v_result uuid;
begin
  select * into p from public.ai_proposals
  where id = p_proposal_id and user_id = v_user
  for update;
  if not found then
    raise exception 'proposal not found' using errcode = 'P0002';
  end if;
  if p.status <> 'pending' then
    raise exception 'this proposal was already %', p.status using errcode = 'P0001';
  end if;
  -- Permissions are checked now, not when Jarvis made the suggestion.
  if not private.has_workspace_role(p.workspace_id, 'member') then
    raise exception 'you need member access to do this' using errcode = '42501';
  end if;

  if p_confirm then
    if p.kind = 'task' then
      insert into public.tasks (workspace_id, title, notes, due_at, priority, company_id, contact_id, deal_id, created_by)
      values (
        p.workspace_id,
        p.payload ->> 'title',
        p.payload ->> 'notes',
        (p.payload ->> 'due_at')::timestamptz,
        coalesce((p.payload ->> 'priority')::public.task_priority, 'normal'),
        (p.payload ->> 'company_id')::uuid,
        (p.payload ->> 'contact_id')::uuid,
        (p.payload ->> 'deal_id')::uuid,
        v_user
      )
      returning id into v_result;
    elsif p.kind = 'lead' then
      -- Details were fetched from Google Maps by the server when proposed.
      insert into public.companies (workspace_id, name, phone_e164, website, address, source, attributes, created_by)
      values (
        p.workspace_id,
        p.payload ->> 'name',
        p.payload ->> 'phone_e164',
        p.payload ->> 'website',
        p.payload ->> 'address',
        'google_maps',
        coalesce(p.payload -> 'attributes', '{}'::jsonb),
        v_user
      )
      returning id into v_result;
      insert into public.deals (workspace_id, company_id, title, stage, created_by)
      values (p.workspace_id, v_result, left('New lead: ' || (p.payload ->> 'name'), 200), 'lead', v_user);
    else
      insert into public.activities (workspace_id, type, direction, summary, company_id, contact_id, deal_id, source, created_by)
      values (
        p.workspace_id,
        coalesce((p.payload ->> 'type')::public.activity_type, 'note'),
        coalesce(p.payload ->> 'direction', 'internal'),
        p.payload ->> 'summary',
        (p.payload ->> 'company_id')::uuid,
        (p.payload ->> 'contact_id')::uuid,
        (p.payload ->> 'deal_id')::uuid,
        'jarvis',
        v_user
      )
      returning id into v_result;
    end if;
  end if;

  update public.ai_proposals
  set status = case when p_confirm then 'confirmed' else 'dismissed' end,
      result_id = v_result,
      decided_at = now()
  where id = p.id;

  perform private.write_audit(p.workspace_id,
    case when p_confirm then 'jarvis.proposal_confirmed' else 'jarvis.proposal_dismissed' end,
    'ai_proposal', p.id::text,
    jsonb_build_object('kind', p.kind) || case when v_result is null then '{}'::jsonb
      else jsonb_build_object('result_id', v_result) end);
  return v_result;
end;
$$;
