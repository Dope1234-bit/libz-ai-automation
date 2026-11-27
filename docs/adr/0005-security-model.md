# ADR-0005: Security model — tenant isolation, policy engine, approvals

- **Status:** Accepted
- **Date:** 2026-11-27

## Context

Jarvis acts on behalf of users across personal and business workspaces, reads
untrusted content and holds third-party credentials. A single authorisation bug
or prompt injection could leak data or trigger unwanted actions.

## Decision

1. **Workspace isolation in two layers:** API-level authorisation on every
   request, plus Postgres RLS on every tenant table keyed by `workspace_id`.
2. **Roles:** `owner`, `admin`, `member` and `viewer` per workspace, deny by
   default.
3. **Tool policy engine:** each tool declares a risk level (`read`, `write`,
   `external_communication`, `financial`, `destructive`). The workspace policy
   resolves each call to `allow`, `ask` or `deny`. Defaults: `read` is allowed;
   everything else is `ask`.
4. **Taint tracking:** once a run ingests untrusted content (web, email, files,
   tool output), any non-read action in that run requires approval regardless of
   policy.
5. **Credential isolation:** OAuth tokens are encrypted at rest (envelope
   encryption) and injected at call time; models never see them.
6. **Audit log:** append-only, covering logins, role changes, approvals and tool
   executions.
7. **Spending limits:** per-workspace token and cost quotas, enforced before a run
   starts.

## Consequences

- More friction for risky actions by design; workspaces can relax policy per tool.
- Every new table and tool needs an RLS policy and a risk level, enforced in
  review (see the PR template).
