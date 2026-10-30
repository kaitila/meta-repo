// Real processes, real git worktrees: the case that broke other trackers (R5.1).
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbPath } from "../src/store";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const dir = mkdtempSync(join(tmpdir(), "foreman-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function sh(cmd: string[], cwd: string, env: Record<string, string> = {}) {
  const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env, CLAUDECODE: "", FOREMAN_DB: "", ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function repo() {
  const root = join(dir, `repo-${Math.random().toString(36).slice(2)}`);
  sh(["git", "init", "-q", root], dir);
  sh(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"], root);
  return root;
}

test("every worktree resolves to the main checkout's database", () => {
  const root = repo();
  const wt = join(dir, "wt-a");
  expect(sh(["git", "worktree", "add", "-q", "-b", "a", wt], root).code).toBe(0);
  expect(dbPath(wt)).toBe(dbPath(root));
  expect(dbPath(root).startsWith(root)).toBe(true);
});

test("8 agents in 8 worktrees race for 3 tasks: exactly 3 claims win, all persist", async () => {
  const root = repo();
  for (const n of [1, 2, 3]) {
    const r = sh(["bun", CLI, "add", `task ${n}`, "--check", "cmd: true", "--risk", "auto", "--ready"], root);
    expect(r.code).toBe(0);
  }
  const wts = Array.from({ length: 8 }, (_, i) => {
    const wt = join(dir, `race-${i}-${Math.random().toString(36).slice(2)}`);
    sh(["git", "worktree", "add", "-q", "-b", `race-${i}-${wt.slice(-4)}`, wt], root);
    return wt;
  });
  const runs = await Promise.all(
    wts.map(async (wt, i) => {
      const p = Bun.spawn(["bun", CLI, "claim", "--json"], {
        cwd: wt,
        env: { ...process.env, FOREMAN_DB: "", CLAUDECODE: "1", FOREMAN_ACTOR: `agent-${i}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, code] = [await new Response(p.stdout).text(), await p.exited];
      return { code, out };
    }),
  );
  const winners = runs.filter((r) => r.code === 0).map((r) => JSON.parse(r.out));
  expect(winners.length).toBe(3);
  expect(new Set(winners.map((w) => w.id)).size).toBe(3);
  // and every winner's claim is really in the database
  const listed = JSON.parse(sh(["bun", CLI, "list", "--status", "claimed", "--json"], root).out);
  expect(listed.map((t: { assignee: string }) => t.assignee).sort()).toEqual(winners.map((w) => w.assignee).sort());
}, 30_000);

test("approve is refused inside an agent session and without a terminal", () => {
  const root = repo();
  sh(["bun", CLI, "add", "x", "--check", "cmd: true"], root);
  const r = sh(["bun", CLI, "approve", "T-0001"], root, { CLAUDECODE: "1" });
  expect(r.code).toBe(1);
  expect(r.err).toContain("foreman:");
});

test("reserve decision skips numbers already on disk", () => {
  const root = repo();
  sh(["mkdir", "-p", "docs/decisions"], root);
  sh(["touch", "docs/decisions/D0007-something.md"], root);
  expect(sh(["bun", CLI, "reserve", "decision"], root).out.trim()).toBe("D0008");
  expect(sh(["bun", CLI, "reserve", "decision"], root).out.trim()).toBe("D0009");
});
