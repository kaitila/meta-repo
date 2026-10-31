// The local board (T-0035): one Bun.serve on 127.0.0.1, a read-only JSON API over the
// same Foreman core, and one page with inline CSS/JS (no external assets, works offline).
// The only write is approve, which needs the token `fm serve` prints to its own terminal
// (never to a page or an API response) and, when the browser sends one, our own Origin.
import { timingSafeEqual } from "node:crypto";
import { type Actor, type Event, type Foreman, ForemanError, type Status, type Task } from "../core";
import { pageHtml } from "./page";

export const LANES: Status[] = [
  "draft",
  "ready",
  "claimed",
  "in_progress",
  "in_review",
  "verifying",
  "needs_approval",
  "approved",
  "done",
  "cancelled",
];

export interface BoardOptions {
  foreman: Foreman;
  /** 0 picks a free port. */
  port?: number;
  /** Who approves from the page. null: approving is off (an agent started the board). */
  approver: Actor | null;
}

export interface Board {
  url: string;
  port: number;
  /** Shown once, in the terminal that started the board. null when approving is off. */
  token: string | null;
  stop(): Promise<void>;
}

function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(b).toString("hex");
}

function sameToken(given: string | null, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A task as the board lists it. */
export function card(t: Task) {
  return { id: t.id, title: t.title, status: t.status, risk: t.risk, assignee: t.assignee, updatedAt: t.updatedAt };
}

/** Each acceptance check with the latest verdict recorded for it, if any. */
export function checksWithVerdicts(t: Task, events: Event[]) {
  const latest = new Map<string, { pass: boolean; evidence: string; by: string; at: number }>();
  for (const e of events) {
    if (e.type !== "verified" && e.type !== "verify_failed") continue;
    const results = (e.data.results ?? []) as { check: string; pass: boolean; evidence: string }[];
    for (const r of results) latest.set(r.check, { pass: r.pass, evidence: r.evidence, by: e.actor, at: e.at });
  }
  return t.acceptance.map((c) => ({ ...c, verdict: latest.get(c.id) ?? null }));
}

export function startBoard(opts: BoardOptions): Board {
  const f = opts.foreman;
  const token = opts.approver ? newToken() : null;
  let origins: Set<string> = new Set();
  let hosts: Set<string> = new Set();

  const security = (nonce?: string): Record<string, string> => ({
    "content-security-policy": [
      "default-src 'self'",
      nonce ? `script-src 'nonce-${nonce}'` : "script-src 'none'",
      nonce ? `style-src 'nonce-${nonce}'` : "style-src 'none'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...security(), "content-type": "application/json; charset=utf-8" },
    });
  const fail = (status: number, error: string, message: string) => json({ error, message }, status);

  const state = () => ({
    lanes: LANES,
    tasks: f.list().map(card),
    lastEvent: f.events().at(-1)?.id ?? 0,
    canApprove: token !== null,
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 4499,
    fetch(req) {
      const url = new URL(req.url);
      // DNS rebinding: a page on another name that resolves to 127.0.0.1 sends its own Host.
      if (!hosts.has(req.headers.get("host") ?? "")) return fail(421, "bad_host", "unknown host");
      const path = url.pathname;
      try {
        if (req.method === "GET" || req.method === "HEAD") {
          if (path === "/") {
            const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
            return new Response(pageHtml(nonce, state()), {
              headers: { ...security(nonce), "content-type": "text/html; charset=utf-8" },
            });
          }
          if (path === "/api/tasks") return json(state());
          if (path === "/api/events") {
            const since = Number(url.searchParams.get("since") ?? 0) || 0;
            const events = f.events().filter((e) => e.id > since);
            return json({ events, lastEvent: events.at(-1)?.id ?? since });
          }
          const m = /^\/api\/tasks\/([A-Za-z0-9_-]+)$/.exec(path);
          if (m) {
            const t = f.get(m[1]!);
            const events = f.events(t.id);
            return json({ task: t, checks: checksWithVerdicts(t, events), events });
          }
          return fail(404, "not_found", "no such page");
        }
        const a = /^\/api\/tasks\/([A-Za-z0-9_-]+)\/approve$/.exec(path);
        if (req.method === "POST" && a) {
          const origin = req.headers.get("origin");
          if (origin !== null && !origins.has(origin)) return fail(403, "forbidden", "cross-origin request refused");
          if (!token || !opts.approver) return fail(403, "forbidden", "approving is off on this board");
          if (!sameToken(req.headers.get("x-foreman-token"), token)) {
            return fail(403, "forbidden", "approving needs the token printed by fm serve");
          }
          return json({ task: f.approve(a[1]!, opts.approver) });
        }
        return fail(405, "method_not_allowed", "the board is read-only, except approve");
      } catch (e) {
        if (e instanceof ForemanError) return fail(e.code === "not_found" ? 404 : 409, e.code, e.message);
        return fail(500, "error", "internal error");
      }
    },
  });

  const port = server.port!;
  hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  origins = new Set([...hosts].map((h) => `http://${h}`));
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    token,
    stop: () => server.stop(true),
  };
}
