-- =============================================================================
-- Milestone 1.2 — Conversations, messages and AI usage
--
-- Conversations are private to the user who started them, within a workspace
-- they belong to. Messages and usage rows are written only through the
-- functions below (no direct INSERT/UPDATE/DELETE grants), which check
-- ownership and membership and keep the usage ledger consistent.
--
-- Trust note: the API calls these functions with the user's own token, so a
-- user could also call them directly. The blast radius is their own private
-- conversation and their own usage count (which can only go up). Content stored
-- here is therefore treated as untrusted when it is later read back into
-- prompts or memory.
-- =============================================================================

create type public.message_role as enum ('user', 'assistant');
create type public.message_status as enum ('complete', 'partial', 'error');

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text check (char_length(title) <= 200),
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index conversations_user_workspace_idx
  on public.conversations (user_id, workspace_id, last_message_at desc nulls last);
create index conversations_workspace_idx on public.conversations (workspace_id);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.message_role not null,
  content text not null check (char_length(content) <= 100000),
  status public.message_status not null default 'complete',
  provider text check (char_length(provider) <= 50),
  model text check (char_length(model) <= 200),
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  created_at timestamptz not null default clock_timestamp()
);
create index messages_conversation_created_idx on public.messages (conversation_id, created_at);
create index messages_workspace_idx on public.messages (workspace_id);
create index messages_user_idx on public.messages (user_id);

create table public.ai_usage (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  message_id uuid references public.messages (id) on delete set null,
  provider text not null,
  model text not null,
  input_tokens integer not null check (input_tokens >= 0),
  output_tokens integer not null check (output_tokens >= 0),
  created_at timestamptz not null default now()
);
create index ai_usage_user_created_idx on public.ai_usage (user_id, created_at desc);
create index ai_usage_workspace_created_idx on public.ai_usage (workspace_id, created_at desc);

create trigger conversations_set_updated_at before update on public.conversations
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------

alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.ai_usage enable row level security;

revoke all on public.conversations, public.messages, public.ai_usage from anon, authenticated;
grant select, delete on public.conversations to authenticated;
grant insert (workspace_id, title) on public.conversations to authenticated;
grant update (title) on public.conversations to authenticated;
grant select on public.messages, public.ai_usage to authenticated;

create policy "conversations: owner reads while a member"
  on public.conversations for select to authenticated
  using (user_id = (select auth.uid()) and private.has_workspace_role(workspace_id, 'viewer'));

create policy "conversations: members start their own"
  on public.conversations for insert to authenticated
  with check (user_id = (select auth.uid()) and private.has_workspace_role(workspace_id, 'member'));

create policy "conversations: owner renames"
  on public.conversations for update to authenticated
  using (user_id = (select auth.uid()) and private.has_workspace_role(workspace_id, 'viewer'))
  with check (user_id = (select auth.uid()));

create policy "conversations: owner deletes"
  on public.conversations for delete to authenticated
  using (user_id = (select auth.uid()) and private.has_workspace_role(workspace_id, 'viewer'));

create policy "messages: conversation owner reads"
  on public.messages for select to authenticated
  using (user_id = (select auth.uid()) and private.has_workspace_role(workspace_id, 'viewer'));

create policy "ai_usage: own usage, or workspace usage for admins"
  on public.ai_usage for select to authenticated
  using (user_id = (select auth.uid()) or private.has_workspace_role(workspace_id, 'admin'));

-- -----------------------------------------------------------------------------
-- Functions
-- -----------------------------------------------------------------------------

-- Returns the conversation's workspace if the caller owns it and may write to it.
create function private.writable_conversation(p_conversation_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
begin
  select c.workspace_id into v_workspace_id
  from public.conversations c
  where c.id = p_conversation_id and c.user_id = (select auth.uid());

  if v_workspace_id is null or not private.has_workspace_role(v_workspace_id, 'member') then
    raise exception 'conversation not found' using errcode = 'P0002';
  end if;
  return v_workspace_id;
end;
$$;

create function public.add_user_message(p_conversation_id uuid, p_content text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_workspace_id uuid := private.writable_conversation(p_conversation_id);
  v_id uuid;
begin
  if p_content is null or char_length(btrim(p_content)) = 0 then
    raise exception 'message must not be empty' using errcode = 'P0001';
  end if;

  insert into public.messages (conversation_id, workspace_id, user_id, role, content)
  values (p_conversation_id, v_workspace_id, v_uid, 'user', p_content)
  returning id into v_id;

  update public.conversations
  set last_message_at = now(),
      title = coalesce(title, left(regexp_replace(btrim(p_content), '\s+', ' ', 'g'), 80))
  where id = p_conversation_id;

  return v_id;
end;
$$;

create function public.add_assistant_message(
  p_conversation_id uuid,
  p_content text,
  p_status public.message_status,
  p_provider text,
  p_model text,
  p_input_tokens integer,
  p_output_tokens integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_workspace_id uuid := private.writable_conversation(p_conversation_id);
  v_id uuid;
begin
  insert into public.messages (
    conversation_id, workspace_id, user_id, role, content, status,
    provider, model, input_tokens, output_tokens
  )
  values (
    p_conversation_id, v_workspace_id, v_uid, 'assistant', coalesce(p_content, ''), p_status,
    p_provider, p_model, p_input_tokens, p_output_tokens
  )
  returning id into v_id;

  if p_provider is not null and p_model is not null
     and (coalesce(p_input_tokens, 0) > 0 or coalesce(p_output_tokens, 0) > 0) then
    insert into public.ai_usage (workspace_id, user_id, message_id, provider, model, input_tokens, output_tokens)
    values (v_workspace_id, v_uid, v_id, p_provider, p_model,
            coalesce(p_input_tokens, 0), coalesce(p_output_tokens, 0));
  end if;

  update public.conversations set last_message_at = now() where id = p_conversation_id;
  return v_id;
end;
$$;

-- Tokens the caller has used across all workspaces since the start of the UTC day.
create function public.ai_tokens_used_today()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(u.input_tokens + u.output_tokens), 0)::bigint
  from public.ai_usage u
  where u.user_id = (select auth.uid())
    and u.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc';
$$;

revoke all on function private.writable_conversation(uuid) from public, anon, authenticated;
revoke all on function public.add_user_message(uuid, text) from public, anon;
revoke all on function public.add_assistant_message(uuid, text, public.message_status, text, text, integer, integer) from public, anon;
revoke all on function public.ai_tokens_used_today() from public, anon;

grant execute on function public.add_user_message(uuid, text) to authenticated;
grant execute on function public.add_assistant_message(uuid, text, public.message_status, text, text, integer, integer) to authenticated;
grant execute on function public.ai_tokens_used_today() to authenticated;
