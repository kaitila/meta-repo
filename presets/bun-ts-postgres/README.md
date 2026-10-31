# {{name}}

A Bun HTTP API on Postgres: zod-validated routes, Drizzle with committed migrations, one config schema, tests on a per-worktree test database, and a Docker image behind Caddy. There is no web UI. Why this stack: [D0001](docs/decisions/D0001-bun-drizzle-postgres.md).

## Setup
1. `bun install`
2. A Postgres for development and tests, e.g. `docker run -d --name {{name}}-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5432:5432 postgres:16`
3. `cp .env.example .env`, then `bun run db:migrate` and `bun run dev`.

Every setting is in [configuration](docs/configuration.md).

## Commands
| Command | What it does |
|---|---|
| `bun run dev` | Server with reload on change, on `127.0.0.1:$PORT` |
| `bun run serve` | Server without reload |
| `bun run db:generate` | Write a migration after changing `src/db/schema.ts` |
| `bun run db:migrate` | Apply the migrations in `src/db/migrations` |
| `bun run check` | Typecheck, docs check and tests: run before every commit |

Tests need Postgres at `TEST_DATABASE_URL`. Locally the database tests skip when it isn't reachable; with `CI` set they fail instead.

## Layout
- `src/config.ts`: every environment variable, in one zod schema.
- `src/server/`: routing, CSRF check and health check in `index.ts`; one file per resource in `routes/`.
- `src/db/`: schema, client, migrations.
- `test/`: `setup.ts` is preloaded; `helpers.ts` gives the test database and a request helper.

## Deploy
`docker compose -f deploy/compose.yml up -d --build` with `DOMAIN` and `POSTGRES_PASSWORD` set. The container applies migrations, then serves; Caddy terminates TLS. Postgres has no published port.
