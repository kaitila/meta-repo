import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mainCheckout, normalise, slot } from "../src/slot";

const dir = mkdtempSync(join(tmpdir(), "test-kit-slot-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const git = (args: string[], cwd: string) => Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });

function repoWithWorktrees() {
  const main = join(dir, `main-${Math.random().toString(36).slice(2, 6)}`);
  git(["init", "-q", main], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"], main);
  const a = join(dir, "Feature A!");
  const b = join(dir, "feature-b");
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
  const t = slot({ root: dir, envVar: "TEST_KIT_SLOT_X" });
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
