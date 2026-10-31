# demo-app

A Bun HTTP API on Postgres (no web UI). Setup and layout: [README](README.md). Settings: [configuration](docs/configuration.md). Decisions: [decisions](docs/decisions/README.md).

## Commands
- `bun run check`: typecheck, docs check and tests. Run it before every commit; CI runs the same.
- `bun test test/routes.test.ts`: one test file.
- `bun run typecheck`, `bun run docs:check`.
- `bun run db:generate` after changing `src/db/schema.ts`; commit the migration it writes. Never edit a committed migration.
- Tests use `TEST_DATABASE_URL` (each worktree gets its own database). Locally they skip without Postgres; CI fails without it.

## Rules
- Every route in `src/server/routes/` declares `mcp`: the tool that exposes it to agents, or `skip` with a reason. The parity test enforces it.
- Validate every input with zod via `parse()`. Throw `ApiFailure` for errors the client may see; anything else becomes "internal error" and its text is never logged.
- Read configuration only through `src/config.ts`, and list every new variable in the configuration doc and `.env.example`.
- State-changing routes keep the CSRF check (`x-app: 1` header, same Origin as `APP_URL`).
- Every non-obvious choice gets a decision file in the decisions folder, in the format the docs check enforces.
