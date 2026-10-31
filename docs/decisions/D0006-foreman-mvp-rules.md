# D0006. Foreman MVP: the state machine, who may do what, and how leases end (2026-10-30)

**Status:** Amended by D0008, D0009, D0011

**Context:** [D0002](D0002-build-foreman.md), [R5.1](../research/R5.1-prior-art.md) and [R5.1b](../research/R5.1b-delegatus-yylo.md). This is what `packages/foreman` does at M3.

**Chosen:**
- **States:** draft → ready → claimed → in_progress → in_review → verifying → (needs_approval →) approved → done, plus cancelled.
  - A task can become ready only with at least one acceptance check, also when it is created with `--ready`.
  - Unknown blockers are refused when the task is created. Ready tasks with unfinished blockers can't be claimed.
- **Every write** is one SQLite `BEGIN IMMEDIATE` transaction that writes its event in the same transaction. Events are append-only, enforced by triggers.
- **Who may do what:**
  - Only the holder can report progress, submit or record a verdict.
  - Submitting releases the task.
  - Nobody who claimed or worked on a task may verify it.
  - A verdict needs exactly one result per acceptance check. If all pass, `auto` tasks become approved and `review` tasks need a person. If any fail, the task goes back to ready with the results kept.
  - `approve` is for people only. It is refused for agents (`CLAUDECODE=1`/`FOREMAN_AGENT=1`), outside an interactive terminal, and is absent from MCP.
  - Tasks with risk `human` can't be claimed by agents.
- **Leases end on timeout:** an expired claim returns to ready (or, during verification, to in_review) and someone else can take it. A worker that comes back late is refused as "not the holder", so two workers can't both submit.
  - **Amended:** [D0011](D0011-foreman-dispatch.md) changed this rule. The dispatcher pins the lease to the worker's PID, so a timeout alone never hands the task to someone else; only a dead process does. This is the pinning that "Revisit if" below expected at M6.
- **Numbers that parallel PRs clash on** (decisions, migrations) come from `foreman reserve`. For decisions it also reads `docs/decisions/` on disk.
- **Identity** comes from the environment (`FOREMAN_ACTOR`). This is a guardrail, not a security boundary (D0003). The hard limits are branch protection and the verifier.

**Why:**
- This is the smallest set of rules that makes claims safe across worktrees and keeps sign-off out of the worker's hands.
- The 8-worktree race test (8 processes, 3 tasks, exactly 3 winners, all saved) covers the failure that Beads issue #4767 hit.
- YYLO's stricter lease rule needs to know the worker's process, and nothing knows that until the dispatcher (M6) launches the workers. YYLO's rule is that a timeout alone never hands a task over, only proven death, a handoff or a revoke does.

**Revisit if:**
- The dispatcher lands (M6). Then pin leases to the worker's PID and start time, and let a timeout alone only flag the task instead of reassigning it.
- The verifier needs a third verdict. Delegatus's `needs_decision` (a question for a person, with options and a recommendation) is the candidate.
