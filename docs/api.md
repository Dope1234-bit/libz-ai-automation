# Jarvis API (v1)

Base URL (local): `http://localhost:4000`

All `/v1` endpoints require `Authorization: Bearer <Supabase access token>`.
Tokens are verified locally against the project's published signing keys
(asymmetric algorithms only). The API then queries Postgres **as that user**, so
row-level security applies to every request, in addition to the API's own checks.

Errors always look like:

```json
{ "error": { "code": "forbidden", "message": "…", "requestId": "…" } }
```

Codes: `bad_request` 400, `unauthenticated` 401, `forbidden` 403,
`not_found` 404, `conflict` 409, `rate_limited` 429, `internal_error` 500.
Resources you are not allowed to see return `404`, not `403`, so their existence
is not revealed.

## Endpoints

| Method | Path                                           | Who                                 | Purpose                                                                               |
| ------ | ---------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------- |
| GET    | `/health`                                      | anyone                              | Liveness                                                                              |
| GET    | `/v1/me`                                       | user                                | Current user, profile, workspaces with roles                                          |
| PATCH  | `/v1/me`                                       | user                                | Update `displayName`, `avatarUrl` (https only)                                        |
| GET    | `/v1/workspaces`                               | user                                | Workspaces the user belongs to                                                        |
| POST   | `/v1/workspaces`                               | user                                | Create a business workspace `{ name }`                                                |
| GET    | `/v1/workspaces/:id`                           | member                              | Workspace details                                                                     |
| PATCH  | `/v1/workspaces/:id`                           | admin+                              | Rename `{ name }`                                                                     |
| DELETE | `/v1/workspaces/:id`                           | owner                               | Delete a business workspace                                                           |
| GET    | `/v1/workspaces/:id/members`                   | member                              | Members with roles and profiles                                                       |
| PATCH  | `/v1/workspaces/:id/members/:userId`           | admin+ (owner for admins)           | Change role `{ role: admin \| member \| viewer }`                                     |
| DELETE | `/v1/workspaces/:id/members/:userId`           | self, or admin+ (owner for admins)  | Leave or remove a member (never the owner)                                            |
| GET    | `/v1/workspaces/:id/invitations`               | admin+                              | List invitations                                                                      |
| POST   | `/v1/workspaces/:id/invitations`               | admin+ (owner to invite admins)     | Invite `{ email, role }`; returns the token **once**                                  |
| DELETE | `/v1/workspaces/:id/invitations/:invitationId` | admin+                              | Revoke an open invitation                                                             |
| POST   | `/v1/invitations/accept`                       | invitee (verified email must match) | Accept `{ token }`                                                                    |
| GET    | `/v1/workspaces/:id/audit-logs?limit=50`       | admin+                              | Recent audit events (max 200)                                                         |
| GET    | `/v1/workspaces/:id/conversations`             | member                              | Your conversations in the workspace (newest first)                                    |
| POST   | `/v1/workspaces/:id/conversations`             | member+ (not viewers)               | Start a conversation `{ title? }`                                                     |
| GET    | `/v1/conversations/:id`                        | its owner                           | Conversation with messages                                                            |
| PATCH  | `/v1/conversations/:id`                        | its owner                           | Rename `{ title }`                                                                    |
| DELETE | `/v1/conversations/:id`                        | its owner                           | Delete with all messages                                                              |
| POST   | `/v1/conversations/:id/messages`               | its owner                           | Send `{ content }`; streams the reply (SSE, below)                                    |
| GET    | `/v1/system/status`                            | user                                | API/database status, configured AI providers and models (never keys), your last reply |
| GET    | `/v1/me/usage`                                 | user                                | Your AI tokens used today, the daily limit, and usage by model                        |
| GET    | `/v1/workspaces/:id/memories`                  | member                              | Your memories in this workspace (pinned first)                                        |
| POST   | `/v1/workspaces/:id/memories`                  | member+                             | Save `{ content ≤1000, category?, pinned?, sourceMessageId? }`                        |
| PATCH  | `/v1/memories/:id`                             | its owner                           | Edit `{ content?, category?, pinned? }`                                               |
| DELETE | `/v1/memories/:id`                             | its owner                           | Forget a memory                                                                       |

## Streaming chat

`POST /v1/conversations/:id/messages` responds with `text/event-stream`:

| Event   | Data                                                                     |
| ------- | ------------------------------------------------------------------------ |
| `start` | `{ userMessageId }`: your message was saved                              |
| `model` | `{ provider, model }`: which model is answering (after any fallback)     |
| `delta` | `{ text }`: the next piece of the reply                                  |
| `done`  | `{ messageId, status, usage: { inputTokens, outputTokens, estimated } }` |
| `error` | `{ code, message }`, e.g. `unavailable` when every model is down         |

Before streaming, the endpoint can return `429` (`rate_limited`: too many requests
per minute; `quota_exceeded`: daily token limit) or `503` (no AI provider
configured). Conversations are private to their creator, even from workspace
admins. If the client disconnects, the partial reply is saved with
`status: "partial"`.

## Business (CRM)

Entities: `companies`, `contacts`, `deals`, `projects`, `tasks`, `activities`.
Every entity has the same five routes:

| Method   | Path                                   | Notes                                                        |
| -------- | -------------------------------------- | ------------------------------------------------------------ |
| `GET`    | `/v1/workspaces/:workspaceId/{entity}` | `{ items, total, limit, offset }`; `limit` ≤ 200, `q` search |
| `POST`   | `/v1/workspaces/:workspaceId/{entity}` | camelCase body → `201 { item }`                              |
| `GET`    | `/v1/{entity}/:id`                     | `{ item }`                                                   |
| `PATCH`  | `/v1/{entity}/:id`                     | partial body → `{ item }`                                    |
| `DELETE` | `/v1/{entity}/:id`                     | `204`; admins only (tasks: their author too)                 |

List filters: `company_id`, `contact_id`, `deal_id`, `project_id` where relevant;
`stage` (deals), `status` (projects, tasks), `type` (activities). Tasks also take
`assignee=me` and `view=open|overdue|today`.

- `phone` is normalised to E.164 (default country Zimbabwe, +263) and stored as
  `phone_e164`; `email` is lowercased. Duplicates within a workspace → `409`.
- Contacts carry `marketingConsent` (`unknown`/`granted`/`denied`); `granted`
  requires `consentSource` and `consentAt`. `doNotContact` overrides everything.
- Companies, contacts, deals, projects and activities exist only in **business**
  workspaces; tasks work in personal workspaces too.
- References (company, contact, deal, project, assignee, owner) must belong to the
  same workspace.

### `POST /v1/workspaces/:workspaceId/import/contacts`

Body `{ csv, dryRun = true, defaultCountryCode = "263" }`. Import your own lists
(≤ 2000 rows). Recognised headers: `name`/`full_name`, `email`, `phone`/`mobile`/
`whatsapp`, `company`, `role`/`title`, `notes`. Rows with a missing name, invalid
email or phone, or an email/phone already in the workspace (or earlier in the
file) are skipped with a reason. Dry run returns `{ toCreate, newCompanies,
skipped, preview }` and writes nothing. Imported contacts have consent `unknown`;
importing is not permission to market to them.

### `GET /v1/workspaces/:workspaceId/reports/summary`

Real aggregates: pipeline count and value by stage (per currency), open pipeline,
won/lost this month, open/overdue/due-today tasks, company and contact counts, and
activities in the last 7 days. Revenue is derived from won deals only
(`revenueBasis: "won_deals"`).

## Jarvis tools and proposals

During a chat reply Jarvis may call workspace tools. They run on the server with
the user's own database session, so row-level security limits them to what the
user can see. Business workspaces get `search_clients`, `get_client`,
`pipeline_summary`, `list_deals`, `list_tasks`, `recent_activities`,
`propose_task` and `propose_activity_note`; personal workspaces get `list_tasks`
and `propose_task`. At most 5 tool rounds run per reply.

Extra stream events: `tool` (`{ id, name, status: "running" | "done", label? }`)
and `proposal` (`{ id, kind, summary, payload, status, result_id, created_at }`).
`GET /v1/conversations/:id` also returns the conversation's `proposals`.

Proposals never write business records. The user decides:

| Method | Path                        | Notes                                                          |
| ------ | --------------------------- | -------------------------------------------------------------- |
| `POST` | `/v1/proposals/:id/confirm` | Creates the task or activity → `{ proposal }` with `result_id` |
| `POST` | `/v1/proposals/:id/dismiss` | Creates nothing → `{ proposal }`                               |

A proposal can be decided once (`400` afterwards), only by the user it belongs
to (`404` for others), and only with member access at the time of the decision.
Creation and decision are audited (`jarvis.proposal_*`) without content.

## Rules enforced in the database

- Every user gets a **personal workspace** at sign-up; it cannot be deleted or
  shared.
- Exactly one **owner** per workspace; ownership cannot be granted, removed or
  changed through the API.
- Invitation tokens are 256-bit random values; only their SHA-256 hash is stored.
  They expire after 7 days, are single-use, and only work for the invited,
  **verified** email address.
- The **audit log** is append-only: rows cannot be updated or deleted, even by the
  database owner, and survive deletion of the workspace or user they describe.
- Business records are audited (created, deleted, deal stage changes, task
  completion) without copying their content into the audit log.
