# ADR-0001: TypeScript monorepo with pnpm and Turborepo

- **Status:** Accepted
- **Date:** 2026-11-27

## Context

Jarvis spans a web dashboard, an API, background workers, an AI orchestration
layer and, later, voice. These share domain types, validation schemas and
security rules. The repository started empty.

## Decision

A single TypeScript repository managed by pnpm workspaces and Turborepo:
`apps/*` for deployables and `packages/*` for shared libraries. Strict compiler
settings (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
Zod schemas in `@jarvis/shared` are the single source of truth for data crossing
any boundary.

## Consequences

- One language, one toolchain, atomic changes across UI, API and AI layer.
- Turborepo caching keeps CI fast as the repository grows.
- Python-only AI or voice libraries, if ever needed, run as an isolated service
  behind an HTTP contract rather than joining the monorepo toolchain.
