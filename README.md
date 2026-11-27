# Jarvis

**Libz AI Automation**

Jarvis is an advanced personal and business AI assistant featuring intelligent
conversations, voice interaction, long-term memory, smart automation, and integrated
business management capabilities. Built to become a powerful, secure, and extensible
AI operating assistant.

> **Status:** Phase 1, Milestone 1.0 (repository foundations).

## Repository layout

```
apps/
  web/          Next.js dashboard
  api/          Hono API service (REST + streaming)
packages/
  shared/       Zod schemas, domain types, error codes
  tsconfig/     Shared TypeScript configs
supabase/       Local Supabase config, migrations, seed
docs/           Architecture overview and decision records (ADRs)
```

Planned packages (added in later milestones): `db`, `core`, `ai`,
`integrations`, `ui`, and `apps/worker`.

## Quick start

```bash
corepack enable
pnpm install
cp .env.example apps/api/.env
pnpm db:start   # requires Docker
pnpm dev
```

- Web: http://localhost:3000
- API: http://localhost:4000/health
- Supabase Studio: http://localhost:54323

## Documentation

- [Architecture overview](docs/architecture.md)
- [Architecture decision records](docs/adr/)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## Licence

Proprietary. Copyright © Libz AI Automation. All rights reserved.
