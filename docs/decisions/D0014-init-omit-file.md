# D0014. agent-kit init honours a project's omit list in a sidecar file (2026-10-31)

**Status:** Active

**Context:** `agent-kit init` merges the baseline `.claude/settings.json` ([D0007](D0007-guardrail-layers.md)) into a project's as a union. So a deny, ask or allow rule a project removed on purpose came back on the next init, and so did the guard hook (T-0041).

**Chosen:**
- A project lists the baseline rules it removed on purpose in `.claude/agent-kit.json`, as `{"omit": [...]}`. Each entry is a permission rule, or a hook's `command`. <!-- docs-check: elsewhere -->
- `init` doesn't add an omitted rule, and prints each one it skipped. It never writes this file, and the templates don't ship one.
- The list only stops additions. A rule the project still has stays. Entries that match nothing in the baseline are ignored.
- It applies to a first install too. A malformed file stops `init` before anything is written.

**Why:**
- **A sidecar file, not a key in `settings.json`.** Claude Code validates its settings file, and whether it keeps tolerating an unknown top-level key isn't documented; editors that check it against the published schema may flag one. A separate file can't break the settings Claude Code loads.
- The project's intent lives next to the settings, in the repo, so it's reviewed in PRs like any other guardrail change.
- Exact strings, no patterns: removing a guardrail should be a deliberate line per rule, easy to read in a diff.

**Revisit if:** Claude Code documents a place for tool-specific keys in `settings.json`, or projects need to omit whole groups of rules at once.
