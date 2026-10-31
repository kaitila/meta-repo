# foreman

A local task layer for AI coding agents working in parallel git worktrees. Tasks have acceptance checks. A worker claims a task, someone else verifies it, and sign-off depends on risk. There is no server, account or hosted service.

Status: MVP (step M3). The dispatcher, the verifier launcher, the janitor and the web board come in M6. The rules are in [D0006](../../docs/decisions/D0006-foreman-mvp-rules.md).

## How it works

- **One database per repository**, at `<main checkout>/.foreman/foreman.db` (SQLite, WAL mode). It is found from any worktree through git's shared directory, so every agent sees the same tasks. Add `.foreman/` to `.gitignore`.
- **Every change** is one transaction plus an event in an append-only log.
- **Claims are atomic and expire.** A worker keeps a claim alive with `heartbeat` or `progress`, and an expired claim goes back to `ready`.
- **Verification:** the worker submits a PR and lets go. Someone who didn't work on the task verifies it, recording one result per acceptance check.
- **Sign-off** ([D0008](../../docs/decisions/D0008-risk-from-paths.md)):
  - `auto` tasks are approved once every check passes.
  - `review` tasks also need a person's `approve`.
  - `human` tasks are claimed and finished only by people.
  - **Default risk:** a task is `auto` unless its declared paths touch the `protectedPaths` in `foreman.json` (guardrails, CI, foreman itself).
  - **The diff decides:** when an `auto` task passes, foreman diffs its branch against main. If any protected file changed, or the diff can't be seen, the task goes to a person instead.
- **Reserving numbers:** `reserve <kind>` hands out the highest number on disk or reserved before, plus one. On disk means `docs/decisions/D*` file names for `decision`, and nothing for other kinds, unless `foreman.json` names a source for the kind. The pattern's first capture group is the number, and paths are relative to the repo root:
  ```json
  { "numbers": {
      "decision": { "file": "docs/decisions.md", "pattern": "^## D(\\d+)\\." },
      "migration": { "glob": "db/*.sql", "pattern": "^(\\d+)_" } } }
  ```
  With `file`, the pattern runs over the file's text (multiline). With `glob`, it runs over each matched file's name. An entry replaces the default for its kind. A glob that matches nothing counts as empty (an empty folder is real), but a `file` that doesn't exist or can't be read is refused with its path, so `reserve` never hands out a number that file may already use. A malformed entry (neither or both of `file` and `glob`, or a pattern without a capture group) is refused.
- **Exporting:** `export` writes a task as markdown (spec, checks, verdict, history) for the PR that delivers it.

```
draft → ready → claimed → in_progress → in_review → verifying → approved → done
                  ↑                                    │  └→ needs_approval → (person) approved
                  └──────── a check failed ────────────┘
```

## Use

One-time setup, from the repo root: `bun install && bun run link`. This links the `fm` command (and `foreman`, the same thing) into `~/.bun/bin`. After that, run `fm` in any git repository: it uses that repo's tasks, because the database is found from the current directory. Without the link, `bun packages/foreman/src/cli.ts` does the same.

```sh
fm help

foreman add "Add a stage filter" --check "cmd: bun test" --check "the filter shows on /investors" \
  --path "web/src/pages/**" --risk review --ready
foreman next                       # what can be claimed now
foreman claim                      # claim the next ready task (or: foreman claim T-0001)
foreman progress T-0001 --branch t-0001 --note "filter wired"
foreman submit T-0001 --pr https://github.com/me/repo/pull/12 --summary "..."
FOREMAN_ACTOR=verifier-1 foreman verify T-0001
FOREMAN_ACTOR=verifier-1 foreman verdict T-0001 --result "c1:pass:bun test 40 pass" --result "c2:pass:seen on /investors"
foreman approve                    # people only, in a terminal: everything waiting, after one yes
foreman approve T-0001 T-0002      # or just these
foreman merged T-0001              # refused if the PR moved after it was verified
foreman edit T-0001 --add-path "docs/**"   # while working: the holder may only add paths
foreman rework T-0001 --reason "gap found after the verdict"   # back to ready; verify again
foreman reserve decision           # next free Dnnnn, so parallel PRs never clash
foreman export T-0001              # docs/tasks/T-0001.md
```

Every command takes `--json`.

## Agents

- **MCP:** add foreman as a server. This repo's own `.mcp.json` does that:
  ```json
  { "mcpServers": { "foreman": { "type": "stdio", "command": "bun", "args": ["packages/foreman/src/cli.ts", "mcp"] } } }
  ```
- **MCP tools:** `list_tasks`, `next_tasks`, `show_task`, `create_task`, `claim_task`, `heartbeat`, `report_progress`, `submit_task`, `start_verify`, `record_verdict`, `mark_merged`, `reserve_number`, `edit_task`, `rework_task`. There is no approve tool.
- **The PR** ([D0009](../../docs/decisions/D0009-edit-rework-verified-head.md)):
  - **On submit:** a GitHub PR must be on this repo, and its branch must be the task's.
  - **At the verdict:** foreman records the PR's head commit.
  - **On merge:** `merged` is refused if the PR has changed since. Rework and verify again.
- **Identity:** `FOREMAN_ACTOR` names the caller. A command Claude Code runs for the model (`CLAUDE_CODE_CHILD_SESSION=1`) counts as an agent. IDE terminals don't, even though Claude Code sets `CLAUDECODE=1` there. This is a guardrail, not a security boundary: branch protection and the verifier are the hard limits.
