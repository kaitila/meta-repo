# D0017. The design kit: one tokens.css per app, a lint against raw values, a server-rendered page, optional screenshots (2026-10-31)

**Status:** Active

**Context:** R8 asks for a design kit an agent can't drift from: a tokens file as the single source, a lint against raw values, a minimal UI in the demo, and a screenshot design critic. The check is "re-skin the demo by editing one tokens file; the lint catches a raw hex".

**Chosen:**
- **Tokens are CSS custom properties in one `tokens.css`,** in a strict format: one `:root` block, plus `:root` overrides under `prefers-color-scheme: dark` and `prefers-reduced-motion: reduce`. `tokens.ts` is generated from it (`design-kit tokens`, `--check` fails when it's stale) for the few places CSS variables can't reach, such as `<meta name="theme-color">`.
- **An app owns its copy.** `packages/design-kit/tokens.css` is the default palette; the preset's `src/ui/tokens.css` is a copy (a test keeps them equal in this repo), and an app made from the preset re-skins by editing its own. The page reads tokens at runtime, so design-kit stays a dev dependency and stays out of the Docker image.
- **The lint (`design-kit lint`) is token-aware, not a general CSS linter.** It fails on hex, `rgb()`/`hsl()` and the other colour functions, on non-zero `px`, and on `var(--x)` when `--x` is neither a token nor defined in the same file. In CSS it reads declaration values and at-rule conditions only, so `#add` as a selector isn't a colour. A line marked `design-lint-allow` is skipped. Named colours (`red`) and unitless numbers in JS style objects are not caught.
- **The demo page is server-rendered HTML from a template string, plus one small script** for the add form. No framework, no bundler, no JSX: the preset is an API starter, and one page doesn't justify a build step. It's served under a strict CSP (`default-src 'none'`, scripts and styles from self only).
- **Re-skinning is proven without a browser.** design-kit's `resolveStyles` fills each declaration's `var()` from the tokens, and the demo's test edits only a copy of `tokens.css` and shows every colour declaration on the page changes, in light and dark.
- **Screenshots are optional.** `design-kit screenshot` uses playwright-core if the project installed it, and exits 3 with instructions if not. The design-critic agent template falls back to reviewing the served markup and styles. Neither design-kit nor the preset depends on playwright-core.

**Why:** Custom properties are the one token format the browser applies without a build step, so the tokens file is literally what the page loads, and a change to it can't be missed by a generator. A copy per app keeps generated projects free to diverge, which a shared runtime file would block. A narrow lint aimed at the drift agents actually produce (a pasted hex, a `12px`) is a few hundred lines and has no false positives on the demo, where a full stylelint config would be one more dependency to keep current. playwright-core plus a browser is a large download that most CI runs of a starter don't need.

**Revisit if:** the preset grows a real front end (a framework and a bundler would bring their own token and lint tooling); agents get past the lint with named colours or JS style numbers often enough to matter; or the design critic is needed in CI, which would make playwright-core a real dependency.
