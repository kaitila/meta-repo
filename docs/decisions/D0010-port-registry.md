# D0010. Worktree port blocks are reserved in a registry under the shared git dir (2026-10-31)

**Status:** Active

**Context:** A verifier found that `slot().ports()` gave two worktrees the same ports when their names hashed to the same offset and neither was listening yet. The fix is T-0023, built by a worker agent. Its design choices are recorded here, because `docs/` was outside the worker's task paths.

**Chosen:**
- **Where:** each slot's offset is recorded in `<git common dir>/test-kit/ports.json`, which every worktree of a repository shares. Outside git, a per-user temp dir is used.
- **Allocating:** a slot gets its recorded offset back while its ports are free. Otherwise it takes the first offset, starting from a hash of its name, that is free and recorded for no other slot. When all offsets are taken, `ports()` throws and names the registry.
- **Concurrency:** every read-modify-write holds a `mkdir` lock. A lock whose holder died is taken over after 30 s. The file is replaced atomically (temp file + rename).
- **Cleanup:** entries for worktrees that `git worktree list` no longer shows are dropped when allocating. `releasePorts()` drops a slot's own entry.
- **Main checkout:** it still gets the base ports unchanged.

**Why:**
- A hash alone can't make blocks unique, and probing ports can't see a block that's been assigned but isn't listening yet.
- A file in the shared git dir needs no service and survives restarts. It goes away with the repository.

**Revisit if:** foreman's dispatcher (D0011) starts allocating worktrees. It should then release a slot's ports when it reaps the worktree, or own port allocation outright.
