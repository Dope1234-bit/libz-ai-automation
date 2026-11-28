# ADR-0002: Supabase for database, auth, storage and queues

- **Status:** Accepted
- **Date:** 2026-11-27

## Context

We need Postgres with vector search, authentication with MFA, file storage and a
job queue, on a free tier to start, without operating each service ourselves.

## Decision

Use Supabase:

- **Postgres 17** with `pgvector` for relational data, embeddings and full-text
  search in one store.
- **Supabase Auth** for sign-up and sign-in (email, OAuth providers), MFA (TOTP)
  and session management.
- **Supabase Storage** for user files, with RLS-protected buckets.
- **Supabase Queues (pgmq)** for background jobs instead of Redis, which keeps
  the stack to one free service. We revisit this if job volume or workflow
  complexity outgrows it.

Schema changes are SQL migrations in `supabase/migrations/`, developed against
the local stack (`pnpm db:start`).

## Consequences

- Row-level security is native, so tenant isolation is enforced in the database
  as well as the API.
- The service-role key bypasses RLS: it is server-only and never reaches the
  browser or a model.
- Free-tier projects pause after inactivity and have size limits; production
  will need a paid plan.
- The data region must be chosen before the production project is created.
