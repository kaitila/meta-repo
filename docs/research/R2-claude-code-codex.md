# R2 Claude Code and Codex: one config for both

Checked against the live docs on 2026-10-30:
- Claude Code: `code.claude.com/docs/en/<page>`
- Codex: its docs moved to `learn.chatgpt.com/docs/<page>`; old `developers.openai.com/codex/*` links redirect there.

Lines marked *(unverified)* are not confirmed in the docs. Hands-on runs of the same 5 tasks in both tools are still open.

## Changes since mid-2026 that shape the design
- Claude Code reads `AGENTS.md` natively (v2.1.277+), but **only when there is no `CLAUDE.md`**.
- Codex has full hooks with a Claude-style event model.
- Codex custom prompts are deprecated in favour of skills.
- `codex mcp-server` is removed.

## Capability matrix

| | Claude Code | Codex CLI |
|---|---|---|
| **Instructions** | `CLAUDE.md` (+ `.claude/rules/`); `@file` imports (up to 4 hops); subdirectory files load on demand | `AGENTS.md` (or `AGENTS.override.md`) from the git root down to the working directory, one per directory; **no imports**; 32 KiB combined limit; **subdirectory files below the working directory never load** |
| **Skills** | `.claude/skills/<n>/SKILL.md` (agentskills.io format plus extra keys) | `.agents/skills/<n>/SKILL.md` (agentskills.io format; optional `agents/openai.yaml`) |
| **Subagents** | `.claude/agents/*.md`, with per-agent tools, model, permission mode, max turns, hooks, worktree isolation | `.codex/agents/*.toml` (`developer_instructions`); **cannot set sandbox, approvals or MCP per agent** |
| **Hooks** | Many events; PreToolUse blocks with `permissionDecision:"deny"` or exit 2 | `.codex/hooks.json`: PreToolUse, PostToolUse, SessionStart, Stop, and others; same deny output; **fails open** on error or timeout; hosted tools (web search) are not covered; needs trust (`/hooks`) |
| **Permissions** | allow/ask/deny rules; the doc says Bash rules are "not a security boundary"; OS sandbox with `denyRead` | `sandbox_mode` + `approval_policy`; permission profiles for deny-read globs; Starlark `.rules` for commands; `.git` and `.codex` stay read-only inside the sandbox |
| **MCP client** | `.mcp.json` (stdio, http) | `[mcp_servers.*]` in `.codex/config.toml` (trusted projects only) |
| **Headless** | `claude -p --output-format json --json-schema … --max-turns N --max-budget-usd X`; `--bare` skips project hooks and MCP | `codex exec --json --output-schema f -o out --sandbox workspace-write`; read-only by default; **no turn or cost cap** |
| **Worktrees** | `--worktree`, subagent `isolation: worktree`, `.worktreeinclude` | `--worktree` on exec; naming *(unverified)* |
| **SDK** | Claude Agent SDK (TS, Python) | `@openai/codex-sdk` (TS), `openai-codex` (Python) |

## What the generator emits (one source → both tools)

1. **Instructions:**
   - The canonical file is `AGENTS.md`: under 32 KiB, with no `@` imports.
   - `CLAUDE.md` holds one line: `@AGENTS.md`. It works on every Claude Code version and keeps working if a user adds `CLAUDE.local.md`.
   - Foreman launches Codex in the package being worked on, so that package's `AGENTS.md` loads.
2. **Skills:** the canonical copy is `agent/skills/<n>/SKILL.md` with only `name` and `description` frontmatter. Copies are generated into `.claude/skills/` and `.agents/skills/` (copies, not symlinks, until symlinks are tested).
3. **Subagents:**
   - Defined once with name, description, instructions, model and tools.
   - Emitted as `.claude/agents/*.md` and `.codex/agents/*.toml`.
   - Per-role limits in Codex are set at launch: each role runs as its own `codex exec` with its own sandbox.
4. **Hooks:**
   - One guard script reads the JSON on stdin and accepts both payload shapes. Whether the field names match is *(unverified)*.
   - It is wired into `.claude/settings.json` and `.codex/hooks.json` for PreToolUse, SessionStart and Stop.
5. **Permissions:** one policy (denied commands, denied-read globs, writable roots), emitted as:
   - Claude Code: `permissions.deny` plus `sandbox.filesystem.denyRead`.
   - Codex: a `default_permissions` profile plus `.codex/rules/*.rules`.
6. **MCP:** defined once, emitted to `.mcp.json` and `.codex/config.toml`. Neither tool serves MCP for the other.
7. **Launch adapter:** both CLIs (or SDKs) are normalised to {final text, structured output, session id, usage/cost, exit status}.

## What the agent tools can't enforce, so foreman must

- **Pushing to main:** both tools' command rules can be bypassed (`git -C . push`). Use server-side branch protection, a local `pre-push` hook, and no push credentials in the worker's environment.
- **Secrets:** keep real secrets out of worktrees entirely.
- **Budgets:** Codex has no turn or cost limit. Foreman sets a wall-clock timeout, tracks token use from `turn.completed`, and kills the process when either runs out.
- **Path ownership:** hooks and sandboxes help but don't fully cover it. The verifier checks `git diff --name-only` against the task's `paths`.
- **Untrusted config:** `claude -p` without `--bare` runs project hooks and MCP servers without asking. Workers run with config foreman generated (`--bare`, `--ignore-user-config`).
