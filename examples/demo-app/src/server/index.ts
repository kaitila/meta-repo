// The HTTP server: routing, CSRF check, health check and security headers.
import { sql } from "drizzle-orm";
import { env } from "../config";
import { getDb } from "../db/client";
import { ApiFailure, errorResponse, json, type Route } from "./context";
import { itemRoutes } from "./routes/items";

/** Every API route. Add new route files here. */
export const routes: Route[] = [...itemRoutes];

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type Match = { route: Route; params: Record<string, string> } | { status: 404 } | { status: 405; allow: string[] };

/** Find the route for a request: a match, 404 if no path fits, 405 if the path fits but not the method. */
export function matchRoute(method: string, pathname: string, list: Route[] = routes): Match {
  const parts = pathname.split("/").filter(Boolean);
  const allow: string[] = [];
  for (const route of list) {
    const want = route.path.split("/").filter(Boolean);
    if (want.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const fits = want.every((w, i) => {
      if (w.startsWith(":")) {
        try {
          params[w.slice(1)] = decodeURIComponent(parts[i]!);
          return true;
        } catch {
          return false;
        }
      }
      return w === parts[i];
    });
    if (!fits) continue;
    if (route.method === method) return { route, params };
    allow.push(route.method);
  }
  return allow.length ? { status: 405, allow } : { status: 404 };
}

/**
 * Requests that change state must carry `x-app: 1`, which a cross-site form or a simple
 * cross-site fetch can't send, and, when the browser sends an Origin, come from APP_URL.
 */
function checkCsrf(req: Request): void {
  if (req.headers.get("x-app") !== "1") throw new ApiFailure("missing x-app header", 403);
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== new URL(env().APP_URL).origin) throw new ApiFailure("cross-origin request refused", 403);
}

async function health(): Promise<Response> {
  try {
    await getDb().execute(sql`select 1`);
    return json({ ok: true, version: env().APP_VERSION });
  } catch {
    return json({ ok: false }, 503);
  }
}

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/healthz") return req.method === "GET" ? health() : json({ error: "method not allowed" }, 405, { allow: "GET" });
  const m = matchRoute(req.method, url.pathname);
  if ("status" in m) {
    return m.status === 404 ? json({ error: "not found" }, 404) : json({ error: "method not allowed" }, 405, { allow: m.allow.join(", ") });
  }
  try {
    if (UNSAFE.has(req.method)) checkCsrf(req);
    return await m.route.handler({ req, url, params: m.params });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Handle one request. Exported so tests call it without opening a port. */
export async function handle(req: Request): Promise<Response> {
  const res = await route(req);
  res.headers.set("x-frame-options", "DENY");
  res.headers.set("referrer-policy", "no-referrer");
  res.headers.set("x-content-type-options", "nosniff");
  if (new URL(req.url).pathname.startsWith("/api/")) res.headers.set("cache-control", "no-store");
  return res;
}

export function startServer(opts: { port?: number; host?: string } = {}) {
  return Bun.serve({
    port: opts.port ?? env().PORT,
    hostname: opts.host ?? "127.0.0.1",
    fetch: handle,
    error: errorResponse,
  });
}
