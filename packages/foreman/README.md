# foreman

A local task layer for AI coding agents working in parallel git worktrees. Tasks have acceptance checks. A worker claims a task, someone else verifies it, and sign-off depends on risk. There is no server, account or hosted service.

Status: MVP (step M3), plus the merge queue and the janitor from M6 ([D0011](../../docs/decisions/D0011-foreman-dispatch.md)). The dispatcher, the verifier launcher and the web board are still to come. The rules are in [D0006](../../docs/decisions/D0006-foreman-mvp-rules.md).

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
foreman merge-queue --once         # merge one approved PR whose checks are green (--dry-run to look)
foreman merge-queue                # the same, every 60 s until stopped (--interval, --settle-seconds 30)
foreman janitor --dry-run          # reclaim, clean up finished tasks, list stuck ones (--stuck-hours 24)
```

Every command takes `--json`.

## Merge queue and janitor

```sh
fm merge-queue --once          # one pass: merge the oldest approved task that is ready
fm merge-queue                 # keep going, a pass every --interval seconds (default 60)
fm merge-queue --dry-run       # say what it would do
fm janitor [--stuck-hours 24] [--dry-run]
```

- **The merge queue** takes approved tasks oldest first and merges at most one per pass, because main moves after every merge. A task merges only if:
  - its PR is still at the verified commit (D0009), and GitHub says it merges cleanly;
  - every check on the head has completed and passed, optional ones included, and at least one has reported;
  - the set of checks is the same on two reads `--settle-seconds` apart (default 30), so a late workflow can't be missed.

  It then runs `gh pr merge --merge --delete-branch --match-head-commit <verified>`, so GitHub refuses if the head moved in between. Everything else is skipped with the reason.
- **A PR that conflicts with main** goes back to `ready` through `sendBackConflict`. Anyone may call it, but foreman reads the PR from GitHub itself and refuses unless it really conflicts ([D0012](../../docs/decisions/D0012-merge-queue-conflict-send-back.md)).
- **The janitor:**
  - reclaims expired leases;
  - for done and cancelled tasks, removes their worktrees, but only ones inside the repo that git lists. One with uncommitted changes is kept and reported;
  - deletes their local branches once they're in main;
  - releases their test-kit ports;
  - lists tasks that have been in one working state longer than `--stuck-hours`, counted from when they entered it, so heartbeats don't hide them.

## Merge queue and janitor

Both run as agents. Without `FOREMAN_ACTOR` they act as `merge-queue` and `janitor`.

- **Merge queue** (`merge-queue`, [D0011](../../docs/decisions/D0011-foreman-dispatch.md), [D0012](../../docs/decisions/D0012-merge-queue-conflict-send-back.md)): approved tasks, oldest first. It merges a PR only when:
  - it is a GitHub PR still at the commit that was verified;
  - its checks are green: at least one, all complete, all SUCCESS, NEUTRAL or SKIPPED (optional ones count too);
  - the checks have settled: the same check names on two reads at least `--settle-seconds` apart;
  - GitHub says it is `MERGEABLE`.
- **The merge** is `gh pr merge --merge --delete-branch --match-head-commit <verified sha>`, so GitHub refuses if the head moved. Then the task is marked merged.
- **One merge per pass.** Main has moved, so the other PRs are read again on the next pass.
- **A PR that conflicts with main** (`CONFLICTING`) goes back to `ready`, to merge main and be verified again. Foreman asks GitHub itself first, so anyone may trigger this, but only a real conflict counts.
- **Anything else** is skipped with the reason and tried again next pass. Without `--once` it loops.
- **Janitor** (`janitor`):
  - reclaims expired claims;
  - for done and cancelled tasks, removes the recorded worktree if it is a clean git worktree inside this repo. One with uncommitted changes is kept and reported;
  - releases that worktree's test-kit ports, if `@meta-repo/test-kit` is installed;
  - deletes the task's local branch only if it is already in `main` or `origin/main`;
  - lists tasks in `claimed`, `in_progress`, `in_review` or `verifying` for longer than `--stuck-hours` since they entered that state.

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
