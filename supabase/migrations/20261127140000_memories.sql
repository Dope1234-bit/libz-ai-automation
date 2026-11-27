-- =============================================================================
-- Stage C — Memory foundation
--
-- Things a user explicitly asks Jarvis to remember. Memories are private to
-- their author and scoped to one workspace, so personal memories never reach
-- business conversations and vice versa. Jarvis reads them (as quoted,
-- user-provided data) when answering in that workspace.
--
-- Phase 2 adds automatic extraction and semantic retrieval (embeddings) on top
-- of this table.
-- =============================================================================

create table public.memories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  content text not null check (char_length(btrim(content)) between 1 and 1000),
  category text not null default 'general'
    check (category in ('general', 'preference', 'fact', 'goal', 'person', 'project')),
  pinned boolean not null default false,
  source text not null default 'manual' check (source in ('manual', 'message')),
  source_message_id uuid references public.messages (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index memories_owner_idx
  on public.memories (user_id, workspace_id, pinned desc, updated_at desc);
create index memories_workspace_idx on public.memories (workspace_id);

create trigger memories_set_updated_at before update on public.memories
  for each row execute function private.set_updated_at();

-- Integrity checks the client cannot bypass: a per-workspace cap, and a source
-- message must be the author's own message in the same workspace.
create function private.check_memory()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and (
    select count(*) from public.memories m
    where m.user_id = new.user_id and m.workspace_id = new.workspace_id
  ) >= 500 then
    raise exception 'memory limit reached for this workspace' using errcode = 'P0001';
  end if;

  if new.source_message_id is not null and not exists (
    select 1 from public.messages msg
    where msg.id = new.source_message_id
      and msg.user_id = new.user_id
      and msg.workspace_id = new.workspace_id
  ) then
    raise exception 'source message not found' using errcode = 'P0002';
  end if;

  return new;
end;
$$;

create trigger memories_check
  before insert or update of source_message_id on public.memories
  for each row execute function private.check_memory();

-- Audit without content: admins can see that memories changed, never what they say.
create function private.audit_memory()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.write_audit(new.workspace_id, 'memory.created', 'memory', new.id::text);
    return new;
  end if;
  if exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
    perform private.write_audit(old.workspace_id, 'memory.deleted', 'memory', old.id::text);
  end if;
  return old;
end;
$$;

create trigger memories_audit
  after insert or delete on public.memories
  for each row execute function private.audit_memory();

revoke all on function private.check_memory() from public, anon, authenticated;
revoke all on function private.audit_memory() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Row-level security: owner only, and only while still a member of the workspace
-- -----------------------------------------------------------------------------

alter table public.memories enable row level security;

revoke all on public.memories from anon, authenticated;
grant select, delete on public.memories to authenticated;
grant insert (workspace_id, content, category, pinned, source, source_message_id)
  on public.memories to authenticated;
grant update (content, category, pinned) on public.memories to authenticated;

create policy "memories: owner reads while a member"
  on public.memories for select to authenticated
  using (user_id = (select auth.uid()) and private.has_workspace_role(workspace_id, 'viewer'));

create policy "memories: members add their own"
  on public.memories for insert to authenticated
  with check (user_id = (select auth.uid()) and private.has_workspace_role(workspace_id, 'member'));

create policy "memories: owner edits"
  on public.memories for update to authenticated
  using (user_id = (select auth.uid()) and private.has_workspace_role(workspace_id, 'member'))
  with check (user_id = (select auth.uid()));

create policy "memories: owner deletes"
  on public.memories for delete to authenticated
  using (user_id = (select auth.uid()) and private.has_workspace_role(workspace_id, 'viewer'));
