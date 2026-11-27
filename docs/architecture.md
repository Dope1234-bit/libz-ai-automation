# Jarvis Architecture

## System overview

```
Browser ──HTTPS──▶ apps/web (Next.js)  ──▶ apps/api (Hono) ──▶ Supabase Postgres (+pgvector, RLS)
   │                                          │   ▲                 Supabase Auth / Storage / Queues
   └── WebRTC (Phase 2) ──▶ voice gateway ────┘   │
                                              apps/worker (memory, embeddings, automations)
                                                  │
                                         Model providers (free tiers: Gemini, Groq,
                                         OpenRouter, local Ollama) via provider router
```

| Layer                       | Choice                                                  | Decision record                                    |
| --------------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| Monorepo                    | pnpm + Turborepo, TypeScript end to end                 | [ADR-0001](adr/0001-typescript-monorepo.md)        |
| Data, auth, storage, queues | Supabase (Postgres 17, pgvector, Auth, Storage, Queues) | [ADR-0002](adr/0002-supabase-platform.md)          |
| API                         | Separate Hono service alongside Next.js                 | [ADR-0003](adr/0003-separate-api-service.md)       |
| Models                      | Multi-provider router, free tiers first                 | [ADR-0004](adr/0004-multi-provider-free-models.md) |
| Security                    | Tenant isolation, policy engine, approvals              | [ADR-0005](adr/0005-security-model.md)             |

## AI orchestration

1. **Gateway:** authenticate, resolve the workspace, rate-limit and check quotas.
2. **Context builder:** system prompt, workspace policies, conversation summary,
   top memories and knowledge chunks, within a token budget.
3. **Model router:** choose provider and model by task (fast or cheap for
   extraction and classification, strongest available for chat and planning),
   falling back across providers on rate limits or errors.
4. **Agent loop:** stream the response and execute tool calls.
5. **Policy engine:** every tool call is `allow`, `ask` or `deny`, based on its
   risk level, the workspace policy and the user's role. `ask` persists the run
   and resumes after approval.
6. **Post-turn jobs:** memory extraction, summarisation, embeddings and usage
   accounting run in the worker.

## Memory tiers

| Tier         | Holds                                             | Lifetime                  |
| ------------ | ------------------------------------------------- | ------------------------- |
| Working      | Current context window                            | One turn                  |
| Conversation | Rolling summary                                   | One thread                |
| Long-term    | Extracted facts, preferences, episodes (embedded) | Persistent, user-editable |
| Knowledge    | Uploaded documents, connected sources             | Persistent                |

Memories are scoped to a workspace: personal memories never surface in a business
workspace. Retrieval is hybrid (pgvector plus full-text) and re-ranked by
relevance, recency and importance.

## Voice (Phase 2)

Voice is another transport into the same orchestrator: WebRTC to streaming
speech-to-text, then the orchestrator, then streaming text-to-speech. Turns are
stored in the same conversations with `channel = 'voice'`. High-risk actions
requested by voice also need confirmation on an authenticated device.

## Phase 1 milestones

| #   | Milestone                                           | Status  |
| --- | --------------------------------------------------- | ------- |
| 1.0 | Repository foundations                              | Done    |
| 1.1 | Data model, Supabase Auth, workspaces, RLS          | Done    |
| 1.2 | Orchestrator core, multi-provider router, streaming | Planned |
| 1.3 | Tool registry, policy engine, approvals, audit log  | Planned |
| 1.4 | Long-term memory v1                                 | Planned |
| 1.5 | Premium dashboard                                   | Planned |
| 1.6 | Hardening, observability, staging                   | Planned |
