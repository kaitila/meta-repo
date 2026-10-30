# meta-repo

A starter for projects where AI coding agents (Claude Code; other tools later, see D0005) write most of the code: agent docs, guardrails, CI, test and design kits, and a task layer ("foreman") that turns requests into agent work and tracks it to sign-off.

## Where things are
- `docs/research-plan.md`: the plan. Tracks R1–R8, steps M0–M8, each gated by a check.
- `docs/decisions/`: one file per decision, `Dnnnn-short-slug.md`.
- `docs/research/`: findings, one file per track (`R5.md`), written when the track's check runs.
- `packages/foreman/`: the task layer ([README](packages/foreman/README.md)).
- `packages/agent-kit/`: guardrail baseline and templates ([README](packages/agent-kit/README.md)). This repo runs its own baseline (`.claude/settings.json`).

## Commands
- `bun install`, then `bun run check` (typecheck + tests). CI runs the same command, plus `bun audit`, gitleaks and zizmor.
- `rm -rf` is denied here: use the tool's own clean command (e.g. `bun install --force`) or ask.

## Tasks
Work on this repo is tracked in foreman itself (MCP server `foreman` in `.mcp.json`, or `bun packages/foreman/src/cli.ts`).
- Before starting: `next_tasks`, then `claim_task`. Report with `report_progress`, hand in with `submit_task` and the PR.
- Found other work on the way: `create_task` with `discoveredFrom`. Search `list_tasks` first.
- Never verify your own task, and never approve: people sign off.
- New decision file: get its number from `reserve_number` (kind `decision`).

## Rules
- Research before building: don't build a step until its track's check has passed and the decision is recorded.
- Every non-obvious choice gets a decision file in the same PR. Format: `# Dnnnn. Title (YYYY-MM-DD)`, then `**Status:** Active | Amended by Dx | Superseded by Dx | Paused`, then **Chosen**, **Why**, **Revisit if**.
- Plans are ordered steps with a check each. No dates or effort estimates.
- Nothing here may depend on a hosted service or reference a private project, person or company.
- PRs only. Never push to main or force-push.
