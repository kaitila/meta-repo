// Worktree "slots": every git worktree gets its own databases, ports and cookie
// names, so parallel agents never share state. Main checkout = slot "" (no suffix).
import { existsSync, readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, dirname, join, resolve } from "node:path";

export interface SlotOptions {
  /** Env var that overrides the slot name (default SLOT). */
  envVar?: string;
  /** Repository root to look at (default: cwd). */
  root?: string;
  /** Max length of the name; keeps database names under Postgres's 63 bytes. */
  maxLen?: number;
}

export function normalise(name: string, maxLen = 40): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, maxLen);
}

/** A linked worktree has a `.git` file ("gitdir: ...") instead of a directory. */
export function isWorktree(root: string): boolean {
  const g = join(root, ".git");
  return existsSync(g) && statSync(g).isFile();
}

/** The main checkout's root, from a worktree's `.git` file; the root itself otherwise. */
export function mainCheckout(root: string): string {
  if (!isWorktree(root)) return root;
  const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(root, ".git"), "utf8"));
  if (!m) return root;
  // <main>/.git/worktrees/<name> → <main>
  return dirname(dirname(dirname(resolve(root, m[1]!.trim()))));
}

export interface Slot {
  /** "" for the main checkout, otherwise the normalised worktree (or env) name. */
  name: string;
  root: string;
  mainCheckout: string;
  /** "app_test" → "app_test_<slot>" (unchanged in the main checkout). */
  dbName(base: string): string;
  /** Swap the database name at the end of a Postgres URL for this slot's. */
  dbUrl(url: string): string;
  /** "session" → "session_<slot>": browsers share cookies across localhost ports. */
  cookieName(base: string): string;
  /**
   * Free ports for this slot, one per base. The main checkout gets the bases; a worktree
   * gets base+i for the first i in 1..range (starting from a hash of the name, so it
   * usually gets the same ones) where every port is free.
   */
  ports(bases: number[], range?: number): Promise<number[]>;
}

export function slot(opts: SlotOptions = {}): Slot {
  const root = resolve(opts.root ?? process.cwd());
  const maxLen = opts.maxLen ?? 40;
  const fromEnv = process.env[opts.envVar ?? "SLOT"];
  const name = fromEnv !== undefined ? normalise(fromEnv, maxLen) : isWorktree(root) ? normalise(basename(root), maxLen) : "";
  const suffix = (base: string) => (name ? `${base}_${name}` : base);
  return {
    name,
    root,
    mainCheckout: mainCheckout(root),
    dbName: suffix,
    dbUrl(url) {
      const u = new URL(url);
      const db = decodeURIComponent(u.pathname.replace(/^\//, ""));
      if (!db) throw new Error("database URL has no database name");
      u.pathname = `/${suffix(db)}`;
      return u.toString();
    },
    cookieName: (base) => suffix(base).replace(/[^A-Za-z0-9_]/g, ""),
    async ports(bases, range = 9) {
      if (!name) return bases;
      const start = hash(name) % range;
      for (let k = 0; k < range; k++) {
        const i = ((start + k) % range) + 1;
        const candidate = bases.map((b) => b + i);
        const busy = await Promise.all(candidate.map((p) => portBusy(p)));
        if (!busy.some(Boolean)) return candidate;
      }
      throw new Error(`no free ports for slot ${name} near ${bases.join(", ")}`);
    },
  };
}

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

export function portBusy(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ port, host });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      done(false);
    });
  });
}
