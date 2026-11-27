# Contributing

## Prerequisites

- Node.js 22 (see `.nvmrc`)
- pnpm 10 (`corepack enable`)
- Docker (for the local Supabase stack)

## Setup

```bash
pnpm install
cp .env.example apps/api/.env
pnpm db:start     # local Supabase: Postgres, Auth, Storage, Studio
pnpm dev          # web on :3000, API on :4000
```

## Before opening a pull request

```bash
pnpm check        # format, lint, typecheck, test
pnpm build
```

## Conventions

- **Branches:** short-lived feature branches off `main`; `main` is protected.
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`).
- **Database changes:** always via a new file in `supabase/migrations/`; never
  edit a migration that has been merged. Every new table enables RLS in the same
  migration.
- **Architecture decisions:** record significant choices as an ADR in
  `docs/adr/`.
- **Security:** follow [SECURITY.md](./SECURITY.md).
