# test-kit

Test infrastructure for Bun + Postgres projects where several agents work at once, each in its own git worktree. It was taken from a production codebase, generalised, and made driver-level (postgres.js), so an app wraps it to hand out its own ORM handle.

| Export | What it does |
|---|---|
| `slot({ envVar?, root? })` | This worktree's slot: `name` ("" in the main checkout), `dbName(base)`, `dbUrl(url)`, `cookieName(base)`, `ports(bases, range?)`, a block of ports reserved for this slot (see below), and `releasePorts()`. That gives each worktree its own databases, ports and cookies. |
| `createTestDb({ url, migrate, keep? })` | `fresh()` empties only the tables that have rows and restarts sequences, with fast replica-mode deletes as superuser and `TRUNCATE` otherwise. `cachedFixture(key, build)` builds once per process and then restores from a snapshot. Also `dumpAllText()` ("this secret never reached the database"), `count(table)`. It refuses databases whose name isn't `*_test` / `*_test_*`. |
| `acquireRunLock(url)` | A Postgres advisory lock named after the test database: a second run against the same database waits. |
| `ensureDatabase`, `dropDatabase` | Create on first use; drop with `force`. |
| `installFetch(routes)` | Replaces `fetch`, tries routes in order, and throws `unexpected request in test` for anything else. Records every call. `on(method, prefix, reply)`, `json()`, `text()`. |
| `fakeLlm(rules)` | A fake model: the first matching rule answers (string, object as JSON, or a function). Hand `converse` to the app's own LLM seam, so its budget guard and logging still run. |
| `stripCredentials(patterns)` | Removes real credentials from the environment so no test can reach a real service. `COMMON_CREDENTIALS` covers `*_API_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD`, `AWS_*`. |
| `affectedTests({ root, changed })` | The tests a change can affect, from the import graph. It over-selects, never under-selects. Lockfiles, configs, migrations and CI select everything. CLI: `affected-tests [--base ref] [--explain]`. |

## Ports
The main checkout gets `bases` unchanged. A worktree gets `base + i` for one offset `i` in `1..range` (default 9), the same `i` for every base. Offsets are reserved in a registry that all worktrees of the repository share: `<git common dir>/test-kit/ports.json` (`slot().registryPath`; a temp dir when the root isn't in git).
- A slot that has an offset recorded gets it back, as long as its ports are free. If something is listening on them, it moves to a new offset and records that.
- A slot without one takes the first offset, starting from a hash of its name, whose ports are free and that no other slot has recorded. Two names whose hashes collide therefore still get different blocks. If no offset is left, `ports()` throws.
- Allocating drops entries for worktrees that no longer exist (not in `git worktree list`). `releasePorts()` drops this slot's entry straight away, e.g. before `git worktree remove`.
- Reads and writes hold a lock (a `ports.json.lock` directory, taken over after 30 s if its holder died) and replace the file atomically, so parallel processes never get the same block.

## Caution
- Replica-mode reset skips **all** triggers while deleting. If your schema relies on triggers to clean up, use a non-superuser test role (the TRUNCATE path).
- Bun 1.3.5 ignores `bunfig.toml`'s test `timeout`; call `setDefaultTimeout` in your preload.

## Testing this package
The database tests need Postgres. Locally they use `TEST_KIT_DATABASE_URL`, defaulting to `postgres://metarepo:metarepo@127.0.0.1:5544/test_kit_test` (see AGENTS.md for the container), and skip if it isn't reachable. On CI a missing database is an error, not a skip.
