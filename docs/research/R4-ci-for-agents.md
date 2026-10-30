# R4 (part) CI/CD for agent work

Researched 2026-10-30 from docs and repo metadata. Items marked *(unverified)* come only from secondary sources.

**Result:** agents don't need a different CI server. They need **one check definition that runs the same way everywhere**: in the agent's worktree, in foreman's verifier, in a pre-push hook and in CI. They also need cheap reruns. CI becomes a thin, trusted re-runner that gates merges. GitHub Actions stays as the merge gate ([D0004](../decisions/D0004-one-check-entrypoint.md)).

## Options looked at

| Option | License / state | Verdict |
|---|---|---|
| **mise tasks / just / Taskfile** | MIT / CC0 / MIT, all active | **Default single entrypoint.** mise also pins tool versions |
| **Dagger** | Apache-2.0, active (v0.21.11, 2026-10) | Containerised steps, same cache locally and in CI, `dagger check`, services such as Postgres. **Optional profile** for when "works on my machine" bites; adds a BuildKit engine |
| Turborepo / Nx | MIT | Affected-only runs plus remote cache; turbo cache can be self-hosted. A good fit for a JS monorepo |
| Bazel / Buck2 | Apache-2.0 | Too heavy for a starter |
| Earthly | Last release 2025-07; cloud shut down; community fork EarthBuild | Avoid for new work |
| Nix CI (Garnix, Hercules) | Garnix reportedly shutting down *(unverified)* | Reproducible but steep to learn; not the default |
| `act` | MIT | Debugging aid for workflows only; gaps in services, secrets and cache |
| **Woodpecker** | Apache-2.0, active | Best open-source CI server if you leave GitHub; fits one VPS |
| Forgejo/Gitea Actions | MIT | Only if git hosting also moves |
| Buildkite | SaaS plus open-source agents | Good, but adds a vendor |
| **GHA self-hosted runner on a separate box** | — | Fixes slow hosted runs (warm cache, local Postgres). The platform fee for self-hosted runners was announced and then postponed *(check GitHub's billing docs)* |

## Merge gating for parallel agent PRs

- N agents branch from the same base, and each PR can be green alone yet break `main` once combined with the others. A merge queue re-tests the combination.
- **GitHub's native merge queue only works on public repos owned by an organisation** (or Enterprise Cloud). `kaitila/meta-repo` is user-owned, so it doesn't qualify yet. Options:
  - Move the repo to an organisation.
  - Use Mergify (free for ≤5 users *(per third-party sources)*).
  - **Foreman's own serial queue:** one merge slot; rebase, recheck, merge.

  The last option works for every user of the starter, so foreman needs it anyway.
- bors-ng is archived. Graphite was acquired by Cursor, which adds vendor risk. Stacked PRs matter less, because agent tasks should be small and independent.

## Agent-specific ideas (2025–2026; blog posts and repo scripts, no mature product)

- **Local verification plus a signed attestation that CI checks** ([stack72.dev](https://stack72.dev/ai-broke-the-assumptions-behind-ci/), 2026-08).
  - The manifest holds the commit SHA, hashes of the governing config (prompts, workflows, AGENTS.md), per-step results and the gate decision.
  - **Limit:** it proves the config and freshness, not that the tests actually ran.
  - So it is only an optimisation for low-risk tasks.
- **Mirror the required checks in git hooks** using a worktree-scoped `core.hooksPath`. Add a PreToolUse hook that blocks `--no-verify`.
- **A result cache keyed by commit SHA**, e.g. `.run/agent-ship-gate.json`. This is "check results stored with the task", which foreman's `events` table can hold.
- **Safe selective CI** ([d4b.dev](https://www.d4b.dev/blog/2026-10-16-ai-coding-selective-ci), 2026-10). It uses the diff against the merge base:
  - Lockfiles, CI config and unknown paths count as "run everything".
  - It **fails closed** if detection errors.
  - One stable final job is the only required check.
  - Shadow-run it before trusting the skips.

## Previews and deploy on one VPS

- **Previews:**
  - **Default:** `docker compose -p pr-<n>` behind Traefik labels, with a wildcard DNS record, a time-to-live and cleanup on PR close, and a cap on how many run at once. No new dependency.
  - **Coolify** (Apache-2.0) has built-in previews for anyone who wants a UI.
  - **Dokploy**'s license is unclear; check it before recommending.
- **Deploy:** keep image → SSH → compose (proven), or use **Kamal 2** (MIT) for zero-downtime deploys and less glue.
- **Don't** run CI runners on the production box. If you have to, use a separate user with resource limits.
