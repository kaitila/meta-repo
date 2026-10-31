# Configuration

Every environment variable the app reads. The schema is in `src/config.ts`; `bun run docs:check` fails when this table and the code disagree, and an empty value counts as unset.

| Variable | Default | What it is |
|---|---|---|
| `DATABASE_URL` | none (required by `serve` and `db:migrate`) | Postgres connection string, `postgres://user:password@host:5432/db`. |
| `APP_URL` | `http://localhost:3000` | The public URL. State-changing requests whose `Origin` isn't this one are refused. |
| `PORT` | `3000` | Port the server listens on. |
| `APP_VERSION` | `dev` | Shown by `/healthz`. The Docker image sets it from the `APP_VERSION` build argument. |
| `TEST_DATABASE_URL` | `postgres://postgres:postgres@127.0.0.1:5432/{{db}}_test` | Tests only. Each git worktree gets its own database under it; its name must end in `_test`. |

## Deploy
[deploy/compose.yml](../deploy/compose.yml) also reads these from the shell or from an `.env` file next to it. They are for Compose, not the app:

- `DOMAIN`: the host name Caddy gets a certificate for.
- `POSTGRES_PASSWORD`: the database password; Compose builds `DATABASE_URL` from it.
