#!/usr/bin/env bun
// Live test of `fm intake` (T-0034, D0011) against real Claude Code.
// Builds a scratch git repo with its own .foreman database, a tiny project and an
// .mcp.json pointing at this checkout's foreman CLI, files one unrelated task, then:
//   1. `fm intake "<request>"` must file at least one draft task with checks and paths,
//      created by intake, and not touch the unrelated task;
//   2. the same request again must report the task from run 1 as a duplicate and file nothing.
// Needs a logged-in `claude`. A few cents with Haiku. Not run in CI. Exit 0 = every expectation held.
// LIVE_TEST_MODEL picks the model (default claude-haiku-5-5); KEEP=1 keeps the scratch repo.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { STRIPPED_ENV } from "../src/launch";

const model = process.env.LIVE_TEST_MODEL ?? "claude-haiku-5-5";
const budget = process.env.LIVE_TEST_BUDGET ?? "0.5";
const CLI = resolve(import.meta.dir, "..", "src", "cli.ts");
const repo = realpathSync(mkdtempSync(join(tmpdir(), "foreman-live-intake-")));
const REQUEST =
  "Add a `--shout` flag to the greet CLI in src/greet.ts that prints the greeting in upper case, with a test.";

let failed = 0;
const expect = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failed++;
};

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIPPED_ENV.includes(k)) env[k] = v;
delete env.FOREMAN_DB;
delete env.CLAUDE_CONFIG_DIR;
env.FOREMAN_ACTOR = "live-person";
delete env.FOREMAN_AGENT;

function fm(...args: string[]) {
  const p = Bun.spawnSync(["bun", CLI, ...args], { cwd: repo, env, stdout: "pipe", stderr: "pipe", timeout: 600_000 });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

interface Result {
  created: { id: string; status: string; acceptance: unknown[]; paths: string[]; createdBy: string; title: string }[];
  duplicates: { id: string; reason: string }[];
  problems: string[];
  costUsd: number;
  turns: number;
  actor: string;
}
function run(label: string): Result | null {
  const r = fm("intake", REQUEST, "--model", model, "--budget", budget, "--json");
  if (r.err.trim()) console.log(`${label} stderr: ${r.err.trim().slice(0, 2000)}`);
  try {
    const res = JSON.parse(r.out) as Result;
    console.log(
      `${label}: exit ${r.code}, created ${JSON.stringify(res.created.map((t) => `${t.id} ${t.status} "${t.title}" checks=${t.acceptance.length} paths=${JSON.stringify(t.paths)} by ${t.createdBy}`))}, ` +
        `duplicates ${JSON.stringify(res.duplicates)}, problems ${JSON.stringify(res.problems)}, ${res.turns} turns, $${res.costUsd.toFixed(3)}`,
    );
    return res;
  } catch {
    console.log(`${label}: exit ${r.code}, unparsable output: ${r.out.slice(0, 2000)}`);
    return null;
  }
}

let cost = 0;
try {
  Bun.spawnSync(["git", "init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, ".gitignore"), ".foreman/\n");
  writeFileSync(
    join(repo, "README.md"),
    "# greet\n\nA tiny CLI: `bun src/greet.ts <name>` prints `Hello, <name>!`.\n\nCheck: `bun test`.\n",
  );
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, "test"));
  writeFileSync(
    join(repo, "src", "greet.ts"),
    'export const greet = (name: string) => `Hello, ${name}!`;\n\nif (import.meta.main) console.log(greet(process.argv[2] ?? "world"));\n',
  );
  writeFileSync(
    join(repo, "test", "greet.test.ts"),
    'import { expect, test } from "bun:test";\nimport { greet } from "../src/greet";\n\ntest("greets", () => expect(greet("Ann")).toBe("Hello, Ann!"));\n',
  );
  writeFileSync(
    join(repo, ".mcp.json"),
    JSON.stringify({ mcpServers: { foreman: { type: "stdio", command: "bun", args: [CLI, "mcp"] } } }, null, 2),
  );
  const seed = fm("add", "Add a CONTRIBUTING.md", "--check", "statement: CONTRIBUTING.md explains how to run bun test", "--path", "CONTRIBUTING.md", "--json");
  const seedId = (JSON.parse(seed.out) as { id: string }).id;
  console.log(`scratch repo ${repo}; unrelated task ${seedId}; request: ${REQUEST}`);

  const first = run("run 1");
  cost += first?.costUsd ?? 0;
  const filed = first?.created ?? [];
  expect(filed.length >= 1, "run 1 files at least one task");
  expect(filed.every((t) => t.acceptance.length >= 1 && t.paths.length >= 1), "run 1: every task has checks and paths");
  expect(filed.every((t) => t.status === "draft"), "run 1: the tasks are drafts (no --ready)");
  expect(filed.every((t) => t.createdBy.startsWith("intake-")), "run 1: created_by names intake");
  expect(!filed.some((t) => t.id === seedId), "run 1 does not refile the unrelated task");
  expect(first?.problems.length === 0, "run 1 reports no problems");

  const second = run("run 2");
  cost += second?.costUsd ?? 0;
  expect(second?.created.length === 0, "run 2 (same request) files nothing");
  expect(
    filed.length > 0 && filed.some((t) => second?.duplicates.some((d) => d.id === t.id)),
    "run 2 reports run 1's task as a duplicate",
  );
  const list = fm("list");
  console.log(`board after both runs:\n${list.out.trim()}`);
  console.log(`(cost $${cost.toFixed(3)}, ${model})`);
} finally {
  if (process.env.KEEP === "1") console.log(`kept ${repo}`);
  else rmSync(repo, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
