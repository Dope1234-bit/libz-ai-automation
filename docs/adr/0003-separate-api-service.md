# ADR-0003: Separate API service alongside Next.js

- **Status:** Accepted
- **Date:** 2026-11-27

## Context

Agent runs are long-lived, streaming and stateful, can pause for approvals, and
voice will need persistent WebSocket or WebRTC connections. Serverless
page-rendering functions have execution time limits and scale differently.

## Decision

`apps/web` (Next.js) serves the dashboard and a thin backend for the UI.
`apps/api` (Hono on Node.js) owns all domain logic, agent orchestration and
streaming (SSE now, WebSockets later). Background work runs in `apps/worker`.

## Consequences

- The API and worker can scale and deploy independently of the UI.
- One authorisation path: every data access goes through the API or RLS.
- Two deployables to operate. The API and worker run as containers (or long-
  running services); the web app can run on Vercel.
