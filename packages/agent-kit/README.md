# agent-kit

Guardrails and templates for projects where Claude Code agents do most of the work.

```sh
bun packages/agent-kit/src/cli.ts init [dir]
```

`init` adds the templates to a repository and never overwrites a file. The one exception is `.claude/settings.json`: if the project already has one, the baseline's permission rules are added to it (a union) and the project's own rules and other keys are kept.

## What's in it

**`templates/.claude/settings.json`**, the permission baseline ([D0007](../../docs/decisions/D0007-guardrail-layers.md)):
- **Deny:**
  - pushing to main or master, force-push, `--no-verify`
  - `git reset --hard`, `rm -rf`
  - `gh repo delete`, `gh secret`, `gh auth`
  - reading `.env` files (Read tool and common shell forms), `*.pem`, `*.key`, `~/.ssh`, `~/.aws`, gh's credentials
- **Ask:** `gh pr merge`, `gh api` writes, `docker`, `ssh`, `scp`.
- **Allow:** read-only git and gh commands, and `.env.example`.

Deny rules always beat allow rules, in any settings file. `settings.local.json` can add allows but can't undo a deny.

These rules are the first layer, not a security boundary: Claude Code's docs say so, and the [live test](../../docs/research/R4-guardrails-tested.md) confirmed it.

**`templates/.claude/hooks/guard.ts`** is the PreToolUse guard, wired in by the settings file. It needs Bun.
- **It parses each command**, so it catches what text rules miss:
  - `git -C . push origin main`, a bare `git push` while on main
  - force-push in any spelling (`-fu`, `--force-with-lease`, `+branch`), deleting remote branches
  - `--no-verify` / `commit -n`, `reset --hard`, `clean -f`
  - recursive force `rm` in any spelling
  - reading or writing `.env` files, also inside `bash -c` and inline code (`bun -e`, `node -e`, `python -c`)
- **Quoted text that only mentions `.env` is allowed**, so `git commit -m "ignore .env files"` works.
- **Task paths:** when the agent has `FOREMAN_ACTOR` set and holds a claimed foreman task with `paths`, edits outside those paths are refused. `docs/tasks/**`, where tasks are exported, is always allowed. It finds foreman through `$FOREMAN_BIN`, then `foreman` on the PATH, then `packages/foreman` in the repo.
- **It fails closed:** a payload it can't read, or an internal error, blocks the call.

Live check: `bun run live-test` runs real headless Claude sessions against both layers, about $0.06 with Haiku. The other layers are CI and branch protection on the server.

**Coming:** the ship skill and test-writer, docs-writer and reviewer agents, wired to foreman (T-0006).
