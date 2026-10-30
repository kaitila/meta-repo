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

These rules are the first layer, not a security boundary: Claude Code's docs say so, and the [live test](../../docs/research/R4-guardrails-tested.md) confirmed it. The other layers are a guard hook (coming: T-0002), CI, and branch protection on the server.

**Coming:** the ship skill and test-writer, docs-writer and reviewer agents, wired to foreman (T-0006).
