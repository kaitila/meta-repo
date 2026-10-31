# Design rules

The rules every page follows. `bun run design:check` enforces the first; the design-critic agent (`.claude/agents/design-critic.md`, if the project has it) reviews pages against all of them. Why the setup looks like this: [D0002](decisions/D0002-pages-from-tokens.md).

## Tokens
1. `src/ui/tokens.css` holds every raw value: colour, type, space, radius, motion, light and dark. Stylesheets and scripts use `var(--name)`; TypeScript that needs a value uses `src/ui/tokens.ts`. No hex, `rgb()`, `hsl()` or `px` anywhere else.
2. To change the look, edit `src/ui/tokens.css`, then `bun run tokens` to regenerate `src/ui/tokens.ts`. Nothing else should need to change.
3. Need a value no token has? Add a token with a role name (`--color-warning`, not `--orange`), with a dark value if it's a colour. Don't put a near-miss value next to an existing token.

## Colour
4. Colours are named by role. `--color-ink` on `--color-bg` or `--color-surface` for text; `--color-ink-muted` for secondary text only.
5. One accent, `--color-accent`, for the page's main action and focus. Don't use it for decoration.
6. Text meets WCAG AA (4.5:1, or 3:1 at 1.5rem and up) in both schemes. Control edges and the focus ring reach 3:1.

## Type
7. The scale is `--text-sm`, `--text-base`, `--text-lg`, `--text-xl`, `--text-2xl` and `--text-display`. Each page has one `h1` in `--font-display`; headings go in order.
8. Body text uses `--font-body` at `--text-base` with `--leading-body`, in a column no wider than `--measure`.
9. Data such as dates, counts and ids uses `--font-mono` at `--text-sm`, with tabular numbers.

## Space and layout
10. Spacing comes from `--space-1` to `--space-8`. Related things sit closer together than unrelated ones.
11. Phone first. At 390 CSS pixels wide nothing scrolls sideways and long text wraps. Wider layouts start at a `min-width` media query in `em`.
12. Controls are at least `--control-height` tall (44 CSS pixels) and have a visible label.

## Behaviour
13. Every control shows focus (`:focus-visible` with `--focus-width` in `--color-focus`).
14. Status and error messages go in a live region (`role="status"`). Errors use `--color-danger` and say what to do.
15. Every list has an empty state that says what to do next. Busy buttons are disabled and marked `aria-busy`.
16. Motion uses `--duration-*` and `--ease-standard`, which drop to 0 under reduced motion.
