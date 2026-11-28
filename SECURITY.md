# Security Policy

Jarvis handles personal and business data, credentials for third-party services
and actions taken on users' behalf. Security is a release requirement, not a
follow-up.

## Reporting a vulnerability

Please **do not** open a public issue. Report privately via GitHub's
"Report a vulnerability" (Security → Advisories) on this repository. We aim to
acknowledge reports within 3 business days.

## Engineering rules

1. **No secrets in git.** Use `.env` files locally (git-ignored) and the hosting
   provider's secret store in deployed environments. CI runs a secret scan.
2. **Tenant isolation.** Every tenant-owned row carries `workspace_id`. The API
   authorises every request, and Postgres row-level security enforces the same
   boundary as defence in depth. RLS is enabled on every table in `public`.
3. **The Supabase service-role key is server-only.** It bypasses RLS and must
   never reach the browser or the model.
4. **Validate at every boundary** with Zod: HTTP input, environment, tool inputs
   and model outputs.
5. **Credentials never reach the model.** Integration tokens are encrypted at
   rest and injected by the integrations layer at call time.
6. **Untrusted content is data, never instructions.** Web pages, emails, files and
   tool output can carry prompt injection. Once a run has read untrusted content,
   any write or outbound action requires explicit user approval.
7. **Least privilege.** Minimal OAuth scopes, minimal CI token permissions, and
   tools default to `ask` unless a workspace policy allows them.
8. **Audit everything sensitive.** Logins, permission changes, approvals and tool
   executions go to an append-only audit log.
9. **Errors never leak internals.** Clients receive a stable error code and a
   request ID; details stay in server logs, with personal data redacted.
