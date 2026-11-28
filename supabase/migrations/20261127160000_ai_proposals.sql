-- =============================================================================
-- Phase 1E — Jarvis proposals.
--
-- Jarvis never writes business records itself. When it suggests creating a
-- task or logging a note, the suggestion is stored here as a proposal and
-- shown to the user as a card. Only the user's explicit confirmation
-- (decide_ai_proposal) creates the record — atomically, once, with the user's
-- own permissions re-checked at that moment. Creation and decision are both
-- audited (without content).
-- =============================================================================

create table public.ai_proposals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('task', 'activity_note')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 20000),
  summary text not null check (char_length(btrim(summary)) between 1 and 500),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'dismissed')),
  result_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  decided_at timestamptz,
  check ((status = 'pending') = (decided_at is null))
);
create index ai_proposals_conversation_idx on public.ai_proposals (conversation_id, created_at);
create index ai_proposals_workspace_idx on public.ai_proposals (workspace_id);
create index ai_proposals_user_idx on public.ai_proposals (user_id);

alter table public.ai_proposals enable row level security;
revoke all on public.ai_proposals from anon, authenticated;
grant select, insert on public.ai_proposals to authenticated;

-- Proposals are private to the user whose conversation produced them.
create policy "ai_proposals: own read" on public.ai_proposals for select to authenticated
  using (user_id = (select auth.uid()) and private.has_workspace_role(workspace_id, 'viewer'));

create policy "ai_proposals: own create" on public.ai_proposals for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and status = 'pending'
    and result_id is null
    and private.has_workspace_role(workspace_id, 'member')
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.workspace_id = ai_proposals.workspace_id
        and c.user_id = (select auth.uid())
    )
  );

create function private.audit_ai_proposal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.write_audit(new.workspace_id, 'jarvis.proposal_created', 'ai_proposal', new.id::text,
    jsonb_build_object('kind', new.kind));
  return new;
end;
$$;
revoke all on function private.audit_ai_proposal() from public, anon, authenticated;

create trigger ai_proposals_audit after insert on public.ai_proposals
  for each row execute function private.audit_ai_proposal();

-- -----------------------------------------------------------------------------
-- Confirm or dismiss a proposal. Returns the created record's id (or null).
-- -----------------------------------------------------------------------------
create function public.decide_ai_proposal(p_proposal_id uuid, p_confirm boolean)
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
revoke all on function public.decide_ai_proposal(uuid, boolean) from public, anon;
grant execute on function public.decide_ai_proposal(uuid, boolean) to authenticated;
