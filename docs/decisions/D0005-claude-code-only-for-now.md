# D0005. Claude Code only for now (2026-10-30)

**Status:** Active

**Chosen:** Build and test everything against Claude Code only. Codex support (generated `.codex/` config, a `codex exec` worker, the "same 5 tasks in both tools" check in R2) is out of scope until it's picked up again. Two rules from [D0003](D0003-one-agent-config.md) stay, so adding Codex later stays cheap:
- `AGENTS.md` stays canonical and `CLAUDE.md` is `@AGENTS.md`.
- Everything Claude-specific (launching `claude -p`, hook payloads, `.claude/` files) sits behind one adapter; foreman's core never depends on it.

Hard limits are still enforced outside the agent (D0003).

**Why:** One agent tool halves the testing surface while foreman's core is unproven. The research for Codex is kept in [R2](../research/R2-claude-code-codex.md).

**Revisit if:** foreman's MVP (M3) and dispatcher (M6) checks pass, or a user asks for Codex.
