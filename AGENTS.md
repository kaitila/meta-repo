# meta-repo

A starter for projects where AI coding agents (Claude Code, Codex) write most of the code: agent docs, guardrails, CI, test and design kits, and a task layer ("foreman") that turns requests into agent work and tracks it to sign-off.

## Where things are
- `docs/research-plan.md`: the plan. Tracks R1–R8, steps M0–M8, each gated by a check.
- `docs/decisions/`: one file per decision, `Dnnnn-short-slug.md`.
- `docs/research/`: findings, one file per track (`R5.md`), written when the track's check runs.

## Rules
- Research before building: don't build a step until its track's check has passed and the decision is recorded.
- Every non-obvious choice gets a decision file in the same PR. Format: `# Dnnnn. Title (YYYY-MM-DD)`, then `**Status:** Active | Amended by Dx | Superseded by Dx | Paused`, then **Chosen**, **Why**, **Revisit if**.
- Plans are ordered steps with a check each. No dates or effort estimates.
- Nothing here may depend on a hosted service or reference a private project, person or company.
- PRs only. Never push to main or force-push.
