// The web page: one server-rendered HTML page listing items, and the static files it
// loads from src/ui/. No framework and no build step: the styles use only the tokens in
// src/ui/tokens.css, which `bun run design:check` enforces (docs/design.md has the rules).
import { desc } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDb } from "../../db/client";
import { type Item, items } from "../../db/schema";
import { dark, light } from "../../ui/tokens";
import type { Route } from "../context";

export const UI_DIR = join(import.meta.dir, "..", "..", "ui");

/** The files under /ui/, and their types. Anything else there is a 404. */
const ASSETS: Record<string, string> = {
  "tokens.css": "text/css; charset=utf-8",
  "app.css": "text/css; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
};

const CSP = "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);

const plural = (n: number) => `${n} ${n === 1 ? "item" : "items"}`;

/** The page's HTML for these items (newest first). */
export function renderPage(list: Pick<Item, "id" | "name" | "createdAt">[], appName = "{{name}}"): string {
  const rows = list
    .map((i) => {
      const iso = i.createdAt.toISOString();
      return `        <li class="item"><span class="item-name">${escapeHtml(i.name)}</span><time class="item-date" datetime="${iso}">${iso.slice(0, 10)}</time></li>`;
    })
    .join("\n");
  const body = list.length
    ? `<ol class="items" aria-labelledby="items-heading">\n${rows}\n      </ol>`
    : `<p class="empty">Nothing here yet. Add the first item above.</p>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Items · ${escapeHtml(appName)}</title>
    <meta name="color-scheme" content="light dark">
    <meta name="theme-color" content="${light.colorBg}" media="(prefers-color-scheme: light)">
    <meta name="theme-color" content="${dark.colorBg}" media="(prefers-color-scheme: dark)">
    <link rel="stylesheet" href="/ui/tokens.css">
    <link rel="stylesheet" href="/ui/app.css">
    <script src="/ui/app.js" defer></script>
  </head>
  <body>
    <main class="page">
      <header class="masthead">
        <p class="eyebrow">${escapeHtml(appName)}</p>
        <h1 class="title">Items</h1>
        <p class="lede">Everything added so far, newest first.</p>
      </header>

      <form class="add" id="add-item" novalidate>
        <label class="add-label" for="item-name">New item</label>
        <div class="add-row">
          <input class="add-input" id="item-name" name="name" type="text" required maxlength="200" autocomplete="off" aria-describedby="add-status">
          <button class="button" type="submit">Add item</button>
        </div>
        <p class="status" id="add-status" role="status" aria-live="polite"></p>
      </form>

      <section class="list" aria-labelledby="items-heading">
        <div class="list-head">
          <h2 class="list-title" id="items-heading">Newest first</h2>
          <p class="count">${plural(list.length)}</p>
        </div>
      ${body}
      </section>
    </main>
  </body>
</html>
`;
}

/** GET /ui/<file>: the page's static files, read from `dir` on each request (so edits show on reload). */
export function assetRoutes(dir = UI_DIR): Route[] {
  return [
    {
      method: "GET",
      path: "/ui/:file",
      mcp: { skip: "static files for the web page" },
      async handler({ params }) {
        const type = Object.hasOwn(ASSETS, params.file!) ? ASSETS[params.file!] : undefined;
        if (!type) return Response.json({ error: "not found" }, { status: 404 });
        return new Response(await readFile(join(dir, params.file!)), { headers: { "content-type": type, "cache-control": "no-cache" } });
      },
    },
  ];
}

export const pageRoutes: Route[] = [
  {
    method: "GET",
    path: "/",
    mcp: { skip: "the web page for people; agents use list_items" },
    async handler() {
      const rows = await getDb().select().from(items).orderBy(desc(items.createdAt)).limit(100);
      return new Response(renderPage(rows), {
        headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, "cache-control": "no-store" },
      });
    },
  },
  ...assetRoutes(),
];
