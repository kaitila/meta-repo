# R8 Design kit

Run on 2026-10-31 (T-0039). Decision: [D0017](../decisions/D0017-design-kit.md).

**Check:** re-skin the demo by editing one tokens file; the lint catches a raw hex.

**Result: passes.** Both halves are tests that run in `bun run check`:
- **Re-skin.** `examples/demo-app/test/ui.test.ts` copies the page's files, edits only `tokens.css` (every colour inverted, a different display face, half the spacing), then serves the page from the copy. All 22 declarations on the page that read a colour token come out different, in light and dark. Among them is `body { background-color }`, which becomes the exact inverse. The display font and padding change too. The same test shows no colour, font or spacing declaration in `app.css` is written without a token.
- **Lint.** The same file adds `color: #e11d48` to a copy of the stylesheet and a raw hex to a TS component. `design-kit lint` reports both with file and line. `packages/design-kit/test/lint.test.ts` shows the CLI exits 1 on a hex in a `.tsx` component, and `bun run design:check` holds the demo's own sources at zero findings.

**What we learned:**
- CSS custom properties make the tokens file the stylesheet itself, so "edit one file" holds with no generator in between. A generated `tokens.ts` is still needed for values outside CSS (`<meta name="theme-color">`), and its `--check` catches a forgotten regeneration.
- A browser isn't needed to prove a re-skin: resolving `var()` from the tokens gives the values the browser would apply. A real browser is still the better critic for layout. With playwright-core and Chromium, the demo page renders at 390 and 1280 wide in both schemes with no sideways scroll.
- The useful lint is narrow: raw colours, `px`, and `var()` names that aren't tokens (a typo like `--colour-ink` otherwise fails silently). Hex-looking id selectors (`#add`) and URL fragments are the false positives to avoid. Reading only CSS values, and skipping `/#` in code, avoids them.
- Gaps: named colours and bare numbers in JS style objects aren't caught. The design critic is a prompt, not yet run against a real UI change.
