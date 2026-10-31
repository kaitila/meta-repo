# D0009. Tasks can be edited before work and sent back after review; what merges must be what was verified (2026-10-30)

**Status:** Active

**Context:** Three gaps the verifiers kept running into:
- Task paths turned out too narrow while working, and there was no way to change a task (T-0009).
- A gap found after a verdict had to be filed as a new task in the same PR, because nothing could send a task back (T-0025).
- A worker could submit some other PR's URL, and a PR could change after it was verified (T-0017).

Amends [D0006](D0006-foreman-mvp-rules.md) and [D0008](D0008-risk-from-paths.md).

**Chosen:**
- **`edit`:**
  - In `draft` or `ready`, anything can change.
  - In `claimed` or `in_progress`, the holder may only **add paths**, and a person may change anything.
  - In review or later (`in_review` … `approved`), nobody can edit: send the task back first.
  - Only a person lowers risk. A ready task keeps at least one acceptance check. New checks get new ids, and ids are never reused.
- **`rework`:** a task's workers or a person can send an `in_review`, `needs_approval` or `approved` task back to `ready`, with a reason. Its old verdict no longer counts: it must be claimed and verified again.
- **The PR is checked on submit and on merge:**
  - **On submit:** a GitHub PR must be on this repository (from the `origin` remote), and its head branch must be the task's recorded branch. If no branch was recorded, the PR's branch becomes the task's.
  - **At the verdict:** a passing verdict records the PR's head commit.
  - **On merge:** `merged` is refused if the PR has moved since. The fix is rework and a fresh verification.
  - **Without GitHub:** non-GitHub PR strings and repos without a GitHub origin are allowed. The verdict-time diff falls back as in D0008.

**Why:**
- Adding paths can't hide anything, because the real diff decides who signs off (D0008). Letting a worker change its checks or its spec after starting would let it grade its own work.
- A verdict is about one commit: approving it must not approve whatever is pushed later. Merging main into a branch after the verdict counts as a change, and that is deliberate.

**Revisit if:** the dispatcher and merge queue (M6) take over merging. They should rebase or merge main, re-run the checks and re-verify automatically, so this stops costing a person anything.
