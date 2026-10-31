# {{name}}

A Bun HTTP API on Postgres, with one server-rendered web page. Setup and layout: [README](README.md). Settings: [configuration](docs/configuration.md). Design rules: [design](docs/design.md). Decisions: [decisions](docs/decisions/README.md).

## Commands
- `bun run check`: typecheck, docs check, design check and tests. Run it before every commit; CI runs the same.
- `bun test test/routes.test.ts`: one test file.
- `bun run typecheck`, `bun run docs:check`, `bun run design:check` (the design lint, and `src/ui/tokens.ts` up to date).
- `bun run tokens` after changing `src/ui/tokens.css`: regenerates `src/ui/tokens.ts`.
- `bun run screenshot -- http://127.0.0.1:$PORT/ --out <dir>`: PNGs of the page at phone and desktop width, light and dark. Needs `playwright-core` and a browser; without them it exits 3 and says how to add them.
- `bun run db:generate` after changing `src/db/schema.ts`; commit the migration it writes. Never edit a committed migration.
- Tests use `TEST_DATABASE_URL` (each worktree gets its own database). Locally they skip without Postgres; CI fails without it.

## Rules
- Every route in `src/server/routes/` declares `mcp`: the tool that exposes it to agents, or `skip` with a reason. The parity test enforces it.
- Validate every input with zod via `parse()`. Throw `ApiFailure` for errors the client may see; anything else becomes "internal error" and its text is never logged.
- Read configuration only through `src/config.ts`, and list every new variable in the configuration doc and `.env.example`.
- State-changing routes keep the CSRF check (`x-app: 1` header, same Origin as `APP_URL`).
- Pages use only tokens from `src/ui/tokens.css`: no hex, `rgb()`, `hsl()` or `px` anywhere else in `src/` (the design check fails). Follow [design rules](docs/design.md).
- Every non-obvious choice gets a decision file in the decisions folder, in the format the docs check enforces.
