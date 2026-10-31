# D0002. Pages are server-rendered HTML styled only from one tokens file (2026-10-31)

**Status:** Active

**Chosen:** The web page is HTML rendered on the server from a template string (`src/server/routes/page.ts`), with one stylesheet and one small script in `src/ui/`. There is no framework and no build step. Every raw design value lives in `src/ui/tokens.css`, and `src/ui/tokens.ts` is generated from it. `bun run design:check` fails on a raw colour or px value anywhere else in `src/`, and on a stale `tokens.ts`. The page is served under a strict Content-Security-Policy: no inline scripts or styles.

**Why:** One page that lists items doesn't justify a bundler. Server rendering keeps the page working with the same routes, database and tests as the API. With the tokens as CSS custom properties, the file the browser loads is the single source, so editing it re-skins the page with nothing to rebuild. A test shows this, and the lint stops raw values from creeping back in. The rules the page follows are in [design rules](../design.md).

**Revisit if:** the app needs several interactive pages or client-side state. A framework then pays for its build step, and the tokens file carries over as it is.
