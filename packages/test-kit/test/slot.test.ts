import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mainCheckout, nameHash, normalise, slot } from "../src/slot";

const dir = mkdtempSync(join(tmpdir(), "test-kit-slot-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
function git(args: string[], cwd: string) {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r;
}

function repoWithWorktrees() {
  const id = Math.random().toString(36).slice(2, 8);
  const main = join(dir, `main-${id}`);
  git(["init", "-q", main], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"], main);
  mkdirSync(join(dir, `wt-${id}`));
  const a = join(dir, `wt-${id}`, "Feature A!");
  const b = join(dir, `wt-${id}`, "feature-b");
  git(["worktree", "add", "-q", "-b", "a", a], main);
  git(["worktree", "add", "-q", "-b", "b", b], main);
  return { main, a, b };
}

test("two worktrees get different databases, cookies and ports; the main checkout gets the bases", async () => {
  const saved = process.env.SLOT;
  delete process.env.SLOT;
  try {
    const { main, a, b } = repoWithWorktrees();
    const [m, sa, sb] = [slot({ root: main }), slot({ root: a }), slot({ root: b })];
    expect(m.name).toBe("");
    expect(sa.name).toBe("feature_a");
    expect(sb.name).toBe("feature_b");
    const url = "postgres://u:p@localhost:5432/app_test";
    expect(m.dbUrl(url)).toBe(url);
    expect(sa.dbUrl(url)).toBe("postgres://u:p@localhost:5432/app_test_feature_a");
    expect(sb.dbUrl(url)).not.toBe(sa.dbUrl(url));
    expect(sa.cookieName("session")).not.toBe(sb.cookieName("session"));
    expect(await m.ports([4300, 5173])).toEqual([4300, 5173]);
    const [pa, pb] = [await sa.ports([4300, 5173]), await sb.ports([4300, 5173])];
    expect(pa[0]! - 4300).toBe(pa[1]! - 5173); // one offset for the whole block
    expect(pa).not.toEqual([4300, 5173]);
    expect(pb).not.toEqual([4300, 5173]);
    expect(mainCheckout(a)).toBe(main);
  } finally {
    if (saved !== undefined) process.env.SLOT = saved;
  }
});

test("a busy port moves the slot to the next free block", async () => {
  process.env.TEST_KIT_SLOT_X = "busy";
  const t = slot({ root: repoWithWorktrees().main, envVar: "TEST_KIT_SLOT_X" });
  delete process.env.TEST_KIT_SLOT_X;
  const first = await t.ports([47000]);
  const server = createServer().listen(first[0], "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const second = await t.ports([47000]);
    expect(second[0]).not.toBe(first[0]);
  } finally {
    server.close();
  }
});

test("names are safe as database identifiers", () => {
  expect(normalise("My Branch/Name--x")).toBe("my_branch_name_x");
  expect(normalise("x".repeat(80)).length).toBe(40);
});

// --- the shared port registry ------------------------------------------------------

/** A slot named by env var, rooted in `root`: lets a test pick names freely. */
function named(name: string, root: string) {
  process.env.TEST_KIT_SLOT_N = name;
  try {
    return slot({ root, envVar: "TEST_KIT_SLOT_N" });
  } finally {
    delete process.env.TEST_KIT_SLOT_N;
  }
}

/** Two slot names whose hashes give the same starting offset. */
function collidingNames(range = 9): [string, string] {
  const seen = new Map<number, string>();
  for (let i = 0; ; i++) {
    const n = `c${i}`;
    const o = nameHash(n) % range;
    const other = seen.get(o);
    if (other) return [other, n];
    seen.set(o, n);
  }
}

type Entries = Record<string, { offset: number; root: string }>;
const entries = (s: { registryPath: string }) => (JSON.parse(readFileSync(s.registryPath, "utf8")) as { slots: Entries }).slots;

test("the registry lives under the main checkout's git dir, shared by its worktrees", () => {
  const { main, a } = repoWithWorktrees();
  const file = join(main, ".git", "test-kit", "ports.json");
  expect(named("x", a).registryPath).toBe(file);
  expect(named("x", main).registryPath).toBe(file);
});

test("two slots whose names hash to the same offset get different blocks", async () => {
  const { main } = repoWithWorktrees();
  const [n1, n2] = collidingNames();
  expect(nameHash(n1) % 9).toBe(nameHash(n2) % 9);
  const p1 = await named(n1, main).ports([47100, 47200]);
  const p2 = await named(n2, main).ports([47100, 47200]);
  expect(p1[0]! - 47100).toBe(p1[1]! - 47200);
  expect(p2[0]! - 47100).toBe(p2[1]! - 47200);
  expect(p2).not.toEqual(p1);
});

test("a slot gets the same block on a second call, from a fresh slot() too", async () => {
  const { main } = repoWithWorktrees();
  const [n1, n2] = collidingNames();
  await named(n1, main).ports([47300]);
  const s = named(n2, main);
  const first = await s.ports([47300]);
  expect(await s.ports([47300])).toEqual(first);
  expect(await named(n2, main).ports([47300])).toEqual(first);
  expect(entries(s)[n2]!.offset).toBe(first[0]! - 47300);
});

test("a block another slot has recorded is never handed out", async () => {
  const { main } = repoWithWorktrees();
  const s = named("newcomer", main);
  // Every offset but 4 is held by another (live) slot.
  const slots: Entries = {};
  for (const o of [1, 2, 3, 5, 6, 7, 8, 9]) slots[`held${o}`] = { offset: o, root: main };
  mkdirSync(dirname(s.registryPath), { recursive: true });
  writeFileSync(s.registryPath, JSON.stringify({ slots }));
  expect(await s.ports([47400])).toEqual([47404]);
  // With all nine held, it refuses rather than share.
  await expect(named("latecomer", main).ports([47400])).rejects.toThrow(/no free ports/);
});

test("8 processes allocating at once for 8 slots get 8 distinct blocks", async () => {
  const { main } = repoWithWorktrees();
  const mod = join(import.meta.dir, "..", "src", "slot.ts");
  const code = `const { slot } = await import(${JSON.stringify(mod)}); console.log(JSON.stringify(await slot({ root: ${JSON.stringify(main)} }).ports([47500, 47600])));`;
  const kids = Array.from({ length: 8 }, (_, i) =>
    Bun.spawn(["bun", "-e", code], { env: { ...process.env, SLOT: `par${i}` }, stdout: "pipe", stderr: "pipe" }),
  );
  const out = await Promise.all(
    kids.map(async (k) => {
      const [text, err, exit] = await Promise.all([new Response(k.stdout).text(), new Response(k.stderr).text(), k.exited]);
      expect({ exit, err }).toEqual({ exit: 0, err: "" });
      return JSON.parse(text) as number[];
    }),
  );
  expect(new Set(out.map((p) => p[0])).size).toBe(8);
  expect(new Set(out.map((p) => p[1])).size).toBe(8);
  for (const p of out) expect(p[0]! - 47500).toBe(p[1]! - 47600);
  const s = named("par0", main);
  expect(Object.keys(entries(s)).sort()).toEqual(Array.from({ length: 8 }, (_, i) => `par${i}`).sort());
  expect(existsSync(`${s.registryPath}.lock`)).toBe(false);
}, 30_000);

test("releasing a slot frees its block for another slot", async () => {
  const { main } = repoWithWorktrees();
  const [n1, n2] = collidingNames();
  const s1 = named(n1, main);
  const first = await s1.ports([47700]);
  await s1.releasePorts();
  expect(entries(s1)[n1]).toBeUndefined();
  // n2 starts from the same offset, which is free again.
  expect(await named(n2, main).ports([47700])).toEqual(first);
});

test("entries for removed worktrees are dropped when allocating", async () => {
  const saved = process.env.SLOT;
  delete process.env.SLOT;
  try {
    const { main, a, b } = repoWithWorktrees();
    const sa = slot({ root: a });
    await sa.ports([47800]);
    expect(entries(sa)[sa.name]).toBeDefined();
    git(["worktree", "remove", "--force", a], main);
    expect(existsSync(a)).toBe(false);
    const sb = slot({ root: b });
    await sb.ports([47800]);
    expect(entries(sb)[sa.name]).toBeUndefined();
    expect(entries(sb)[sb.name]).toBeDefined();
  } finally {
    if (saved !== undefined) process.env.SLOT = saved;
  }
});

test("a corrupt registry is treated as empty and rewritten", async () => {
  const { main } = repoWithWorktrees();
  const s = named("corrupt", main);
  await s.ports([47900]);
  writeFileSync(s.registryPath, "{ not json");
  const p = await s.ports([47900]);
  expect(entries(s).corrupt!.offset).toBe(p[0]! - 47900);
});
