# D0004. One check entrypoint for agents, verifier and CI; GitHub Actions as a thin merge gate (2026-10-30)

**Status:** Active

**Context:** [R4 CI/CD for agent work](../research/R4-ci-for-agents.md).

**Chosen:**
- **One entrypoint:** every project has one check command, `mise run check`, with mise pinning tool versions. Agents, foreman's verifier, a worktree-scoped `pre-push` hook and CI all call it the same way.
- **What it runs:** plain scripts plus an affected-only selector that fails closed. Dagger is an optional profile for hermetic runs with services.
- **CI:** a thin GitHub Actions workflow that runs the entrypoint on `pull_request` and `merge_group`, with one stable required job.
- **Runners:** self-hosted on a box separate from production; hosted runners as the fallback.
- **Check results:** stored in foreman's events by commit SHA. A local attestation can shorten CI only for `auto`-risk tasks that don't touch agent config, prompts or CI. Everything else gets a full CI rerun.
- **Merge queue:**
  - Foreman's own serial queue (merge slot → rebase → recheck → merge) is the default.
  - Where the repo qualifies (a public, organisation-owned repo), GitHub's native queue is used instead.
- **Previews:** a compose project per PR behind Traefik, with a time-to-live.
- **Deploy:** the preset keeps image → SSH → compose, and Kamal 2 is documented as the alternative.

**Why:**
- Agents run checks many times per task. What matters is that local and CI results agree and that reruns are cheap, not which CI server runs them.
- GitHub keeps branch protection, required checks and the PR UI, which contributors already know.
- GitHub's native merge queue is not available to user-owned repos (this one included), so the starter can't depend on it.
- Local attestations can't prove that tests ran, so they stay an optimisation.

**Revisit if:** users want to run without GitHub (then Woodpecker or Forgejo Actions), or check runs diverge between local and CI often enough to make Dagger the default.
