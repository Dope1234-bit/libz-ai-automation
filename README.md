# Sir Libz

**Libz AI Automation**

Sir Libz is an advanced personal and business AI assistant featuring intelligent
conversations, voice interaction, long-term memory, smart automation, and integrated
business management capabilities. Built to become a powerful, secure, and extensible
AI operating assistant.

> **Status:** Phase 1 complete — command centre (Personal/Business modes), streaming multi-provider AI chat, memory, browser voice, settings, team invites and audit activity. Deployed on Vercel + Supabase.

## Repository layout

```
apps/
  web/          Next.js dashboard
  api/          Hono API service (REST + streaming)
packages/
  shared/       Zod schemas, domain types, error codes
  tsconfig/     Shared TypeScript configs
supabase/       Local Supabase config, migrations, pgTAP database tests
docs/           Architecture overview and decision records (ADRs)
```

Planned packages (added in later milestones): `db`, `core`, `ai`,
`integrations`, `ui`, and `apps/worker`.

## Quick start

```bash
corepack enable
pnpm install
pnpm db:start                              # requires Docker
cp .env.example apps/api/.env              # paste PUBLISHABLE_KEY from `pnpm db:status`,
                                           # set AI_PROVIDERS and a provider key
cp apps/web/.env.example apps/web/.env.local   # same PUBLISHABLE_KEY
pnpm dev
```

- Web: http://localhost:3000 (sign in, then chat at /app)
- API: http://localhost:4000/health
- Supabase Studio: http://localhost:54323 (with `pnpm db:start:full`)

## Documentation

- [Architecture overview](docs/architecture.md)
- [API reference](docs/api.md)
- [Architecture decision records](docs/adr/)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## Licence

Proprietary. Copyright © Libz AI Automation. All rights reserved.
