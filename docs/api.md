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

| Method | Path                                           | Who                                 | Purpose                                              |
| ------ | ---------------------------------------------- | ----------------------------------- | ---------------------------------------------------- |
| GET    | `/health`                                      | anyone                              | Liveness                                             |
| GET    | `/v1/me`                                       | user                                | Current user, profile, workspaces with roles         |
| PATCH  | `/v1/me`                                       | user                                | Update `displayName`, `avatarUrl` (https only)       |
| GET    | `/v1/workspaces`                               | user                                | Workspaces the user belongs to                       |
| POST   | `/v1/workspaces`                               | user                                | Create a business workspace `{ name }`               |
| GET    | `/v1/workspaces/:id`                           | member                              | Workspace details                                    |
| PATCH  | `/v1/workspaces/:id`                           | admin+                              | Rename `{ name }`                                    |
| DELETE | `/v1/workspaces/:id`                           | owner                               | Delete a business workspace                          |
| GET    | `/v1/workspaces/:id/members`                   | member                              | Members with roles and profiles                      |
| PATCH  | `/v1/workspaces/:id/members/:userId`           | admin+ (owner for admins)           | Change role `{ role: admin \| member \| viewer }`    |
| DELETE | `/v1/workspaces/:id/members/:userId`           | self, or admin+ (owner for admins)  | Leave or remove a member (never the owner)           |
| GET    | `/v1/workspaces/:id/invitations`               | admin+                              | List invitations                                     |
| POST   | `/v1/workspaces/:id/invitations`               | admin+ (owner to invite admins)     | Invite `{ email, role }`; returns the token **once** |
| DELETE | `/v1/workspaces/:id/invitations/:invitationId` | admin+                              | Revoke an open invitation                            |
| POST   | `/v1/invitations/accept`                       | invitee (verified email must match) | Accept `{ token }`                                   |
| GET    | `/v1/workspaces/:id/audit-logs?limit=50`       | admin+                              | Recent audit events (max 200)                        |

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
