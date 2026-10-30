# D0002. Build foreman; borrow from Beads, Backlog.md, Vibe Kanban and Conductor (2026-10-30)

**Status:** Active

**Context:** [R5.1 prior art](../research/R5.1-prior-art.md).

**Chosen:** Build foreman as planned in [D0001](D0001-research-before-template.md):
- SQLite in WAL mode with `BEGIN IMMEDIATE` claims, stored in the main checkout's `.foreman/`.
- The CLI first, with MCP over the same core. Agent docs recommend the CLI.

Borrow:
- **From Beads:**
  - A ready queue built only from `blocks` edges.
  - Atomic `ready --claim` and `close --claim-next`.
  - Leases with heartbeat and `reclaim`.
  - `discovered-from` links for work found mid-task.
  - A merge slot that serialises rebase and merge.
  - A SessionStart hook that re-injects a short brief.
  - Gate types that wait on a CI run or a PR.
  - `--json` on every command.
  - A schema-version guard.
- **From Backlog.md:**
  - The task body: Description, Acceptance Criteria, a project-wide Definition of Done, Plan, Notes and Final Summary.
  - The section-marker markdown format, used for the PR export.
  - Readiness that fails closed.
  - Guidance pulled on demand (`foreman instructions`) instead of a long AGENTS.md.
  - A web board on localhost only.
- **From Vibe Kanban:** per-repo `setup`/`cleanup`/`archive` scripts, `copy_files`, two cleanup tiers, and orphan reconcile at startup.
- **From Conductor:** a fixed block of ports per task, handed to the worker as env vars.

Foreman's own parts:
- Resources per task (database and port block) recorded in shared state and freed by the janitor.
- Acceptance checks stored as structured data.
- A fresh-context verifier.
- Sign-off by risk class. The agent being gated can never pass its own gate: it is resolved by role, enforced by the CLI.

**Why:**
- No tool covers that core.
- Beads is closest, but Dolt brings single-writer limits, cell-merge workarounds and lost writes with parallel agents in worktrees (issue #4767).
- Backlog.md admits it can't coordinate parallel worktrees.
- Vibe Kanban is sunsetting, and its board depended on a cloud that is now gone. Foreman's state must never depend on a hosted service.

**Revisit if:** reading the code of Delegatus (fresh reviewer loop) and YYLO (merge queue routed by risk) before M3 shows that either already does sign-off by risk class plus a worktree-safe claim protocol well enough to build on.
