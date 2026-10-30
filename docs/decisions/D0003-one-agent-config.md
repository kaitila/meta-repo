# D0003. One agent config, generated for Claude Code and Codex; hard limits enforced outside the agent (2026-10-30)

**Status:** Active

**Context:** [R2 Claude Code and Codex](../research/R2-claude-code-codex.md).

**Chosen:**
- **Instructions:** `AGENTS.md` is canonical, with no `@` imports and under 32 KiB. `CLAUDE.md` is generated as one line: `@AGENTS.md`.
- **Skills:** canonical in `agent/skills/` using the portable frontmatter (`name`, `description`), copied to `.claude/skills/` and `.agents/skills/`.
- **Generated per tool:** subagents, the hook wiring, the permission policy and MCP config come from one source, as `.claude/*` + `.mcp.json` and `.codex/*`.
- **Guard script:** one script serves both tools' PreToolUse, SessionStart and Stop hooks.
- **Launching workers:** through one adapter over `claude -p` and `codex exec`. Workers run only with config foreman generated (`--bare` / `--ignore-user-config`).
- **Treated as guardrails, not boundaries:** hooks and permission rules. Hard limits are enforced outside the agent:
  - server-side branch protection, a `pre-push` hook, and no push credentials for workers;
  - no real secrets in worktrees;
  - foreman-side timeouts and token budgets, which Codex has none of;
  - the verifier checking changed paths against the task's `paths`.

**Why:**
- Both tools now share the SKILL.md format and a near-identical PreToolUse contract, so one source is practical.
- Both tools' docs say their command rules and hooks can be bypassed (`git -C . push`), and that Codex hooks fail open.

**Revisit if:** Claude Code starts reading `.agents/skills`, or both tools agree on a shared config format. Either one removes a generated copy.
