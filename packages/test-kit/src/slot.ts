// Worktree "slots": every git worktree gets its own databases, ports and cookie
// names, so parallel agents never share state. Main checkout = slot "" (no suffix).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
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
   * gets base+i for one i in 1..range, reserved for it in a registry shared by all the
   * repository's worktrees (see `registryPath`). A recorded offset is reused while its
   * ports are free; otherwise the first i (starting from a hash of the name) whose ports
   * are free and that no other slot has recorded is taken and recorded.
   */
  ports(bases: number[], range?: number): Promise<number[]>;
  /** Drops this slot's entry from the registry, so another slot can take its block. */
  releasePorts(): Promise<void>;
  /** The registry file: `<git common dir>/test-kit/ports.json` (a temp dir outside git). */
  registryPath: string;
}

export function slot(opts: SlotOptions = {}): Slot {
  const root = resolve(opts.root ?? process.cwd());
  const maxLen = opts.maxLen ?? 40;
  const fromEnv = process.env[opts.envVar ?? "SLOT"];
  const name = fromEnv !== undefined ? normalise(fromEnv, maxLen) : isWorktree(root) ? normalise(basename(root), maxLen) : "";
  const suffix = (base: string) => (name ? `${base}_${name}` : base);
  const top = real(git(["rev-parse", "--show-toplevel"], root) ?? root);
  const registry = registryFile(root);
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
    registryPath: registry,
    async ports(bases, range = 9) {
      if (!name) return bases;
      return withLock(registry, async () => {
        const reg = readRegistry(registry);
        dropStale(reg, root, name);
        const block = (i: number) => bases.map((b) => b + i);
        const free = async (i: number) => !(await Promise.all(block(i).map((p) => portBusy(p)))).some(Boolean);
        const mine = reg.slots[name];
        let offset: number | undefined;
        if (mine && mine.offset >= 1 && mine.offset <= range && (await free(mine.offset))) offset = mine.offset;
        if (offset === undefined) {
          const taken = new Set(Object.entries(reg.slots).filter(([n]) => n !== name).map(([, e]) => e.offset));
          const start = nameHash(name) % range;
          for (let k = 0; k < range && offset === undefined; k++) {
            const i = ((start + k) % range) + 1;
            if (i !== mine?.offset && !taken.has(i) && (await free(i))) offset = i;
          }
        }
        if (offset === undefined) throw new Error(`no free ports for slot ${name} near ${bases.join(", ")}`);
        if (mine?.offset !== offset || mine.root !== top) {
          reg.slots[name] = { offset, root: top };
          writeRegistry(registry, reg);
        }
        return block(offset);
      });
    },
    async releasePorts() {
      if (!name) return;
      await withLock(registry, async () => {
        const reg = readRegistry(registry);
        if (!(name in reg.slots)) return;
        delete reg.slots[name];
        writeRegistry(registry, reg);
      });
    },
  };
}

// --- port registry -------------------------------------------------------------------

interface Registry {
  slots: Record<string, { offset: number; root: string }>;
}

function git(args: string[], cwd: string): string | undefined {
  if (!existsSync(cwd)) return undefined;
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** The registry lives in the git dir every worktree of the repository shares. */
function registryFile(root: string): string {
  const common = git(["rev-parse", "--git-common-dir"], root);
  const base = common ? resolve(root, common) : join(tmpdir(), "test-kit-no-git");
  return join(base, "test-kit", "ports.json");
}

function readRegistry(file: string): Registry {
  try {
    const r = JSON.parse(readFileSync(file, "utf8")) as Partial<Registry>;
    if (r && typeof r.slots === "object" && r.slots) return { slots: r.slots };
  } catch {
    // missing or unreadable: start empty
  }
  return { slots: {} };
}

/** Write a temp file and rename it over the registry, so a reader never sees half a file. */
function writeRegistry(file: string, reg: Registry): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(reg, null, 2)}\n`);
  renameSync(tmp, file);
}

/** Drops entries (other than `keep`) whose worktree is gone: not in `git worktree list`, or deleted. */
function dropStale(reg: Registry, root: string, keep: string): void {
  const list = git(["worktree", "list", "--porcelain"], root);
  const live = list === undefined ? undefined : new Set(list.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => real(l.slice(9))));
  for (const [n, e] of Object.entries(reg.slots)) {
    if (n === keep) continue;
    if (!existsSync(e.root) || (live && !live.has(real(e.root)))) delete reg.slots[n];
  }
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 60_000;

/** An exclusive lock between processes: `mkdir` either creates the lock dir or fails. */
async function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        // A holder that died leaves the dir behind; take it over once it is old enough.
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmdirSync(lock);
      } catch {
        // released (or taken over) meanwhile: just retry
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for the port registry lock ${lock}`);
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 40));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      // already gone
    }
  }
}

/** The hash `ports()` starts its search from (offset = 1 + hash % range). */
export function nameHash(s: string): number {
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
