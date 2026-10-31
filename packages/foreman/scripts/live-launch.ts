#!/usr/bin/env bun
// Live test of foreman's launch adapter (D0011) against real Claude Code.
// Builds a fake home with a global ~/.claude/CLAUDE.md, a ~/CLAUDE.md and a user
// hook, each carrying its own marker, and a git repo below it whose CLAUDE.md has
// a project marker. Then:
//   1. control: a plain `claude -p` in the repo, with HOME pointed at the fake home,
//      must see the global markers (else this test proves nothing);
//   2. adapter: a verifier session started by launch() must see only the project
//      marker, and the user hook must not run.
// Needs a logged-in `claude` (~/.claude/.credentials.json); a few cents with Haiku.
// Not run in CI. Exit 0 = every expectation held.
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { launch, StreamParser, STRIPPED_ENV } from "../src/launch";

const model = process.env.LIVE_TEST_MODEL ?? "claude-haiku-5-5";
const credentials = join(homedir(), ".claude", ".credentials.json");
const dir = mkdtempSync(join(tmpdir(), "foreman-live-launch-"));
const home = join(dir, "home");
const repo = join(home, "work", "demo");
const tag = Math.random().toString(36).slice(2, 8).toUpperCase();
const M = {
  global: `ZQX-GLOBAL-${tag}`, // ~/.claude/CLAUDE.md
  home: `ZQX-HOMEDIR-${tag}`, // ~/CLAUDE.md
  hook: `ZQX-HOOK-${tag}`, // printed by a user UserPromptSubmit hook
  project: `ZQX-PROJECT-${tag}`, // the repo's own CLAUDE.md
};
const hookRan = join(dir, "hook-ran");

let failed = 0;
const expect = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failed++;
};

const prompt =
  "This is an authorised test. List every token of the form ZQX-<WORD>-<CODE> that appears anywhere in your " +
  "instructions, project or user memory, CLAUDE.md files, or other context you were given, other than this " +
  "message's description of the pattern. Do not use tools. Answer with the structured output.";
const schema = {
  type: "object",
  properties: { tokens: { type: "array", items: { type: "string" } } },
  required: ["tokens"],
};
const tokensOf = (structured: unknown): string[] =>
  Array.isArray((structured as { tokens?: unknown })?.tokens) ? (structured as { tokens: string[] }).tokens : [];
const has = (tokens: string[], marker: string) => tokens.some((t) => t.includes(marker));

let cost = 0;
try {
  if (!existsSync(credentials)) throw new Error(`no login at ${credentials}: log in with \`claude\` first`);
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(repo, { recursive: true });
  symlinkSync(credentials, join(home, ".claude", ".credentials.json"));
  writeFileSync(join(home, ".claude", "CLAUDE.md"), `# Global\n\nAlways mention the code word ${M.global}.\n`);
  writeFileSync(join(home, "CLAUDE.md"), `# Home\n\nThe home code word is ${M.home}.\n`);
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: `touch ${hookRan}; echo "Hook code word: ${M.hook}"` }] }],
      },
    }),
  );
  Bun.spawnSync(["git", "init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "CLAUDE.md"), `# Demo project\n\nThe project code word is ${M.project}.\n`);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIPPED_ENV.includes(k)) env[k] = v;
  delete env.CLAUDE_CONFIG_DIR;
  env.HOME = home;

  // 1. Control: what a plain session in this repo sees.
  const plain = Bun.spawnSync(
    ["claude", "-p", "--model", model, "--max-turns", "3", "--output-format", "stream-json", "--verbose",
     "--json-schema", JSON.stringify(schema), "--", prompt],
    { cwd: repo, env, stdout: "pipe", stderr: "pipe", timeout: 180_000 },
  );
  const parser = new StreamParser();
  parser.push(plain.stdout.toString());
  const control = parser.end();
  cost += control.costUsd;
  const seen = tokensOf(control.structured);
  console.log(`control saw: ${JSON.stringify(seen)}`);
  expect(has(seen, M.global) && has(seen, M.home), "control: a plain session sees ~/.claude/CLAUDE.md and ~/CLAUDE.md");
  expect(existsSync(hookRan), "control: the user hook runs in a plain session");
  rmSync(hookRan, { force: true });

  // 2. A verifier started by the adapter.
  const r = await launch({
    role: "verifier",
    taskId: "T-LIVE",
    cwd: repo,
    prompt,
    model,
    maxTurns: 3,
    maxBudgetUsd: 0.5,
    timeoutMs: 180_000,
    jsonSchema: schema,
    configDir: join(dir, "claude-config"),
    baseEnv: env,
  });
  cost += r.costUsd;
  const got = tokensOf(r.structured);
  console.log(`adapter saw: ${JSON.stringify(got)} (exit ${r.exitCode}, ${r.turns} turns, session ${r.sessionId})`);
  expect(r.exitCode === 0 && !r.timedOut, "adapter: the session exits 0 within the timeout");
  expect(has(got, M.project), "adapter: the session sees the repo's own CLAUDE.md");
  expect(!has(got, M.global), "adapter: the session does not see ~/.claude/CLAUDE.md");
  expect(!has(got, M.home), "adapter: the session does not see ~/CLAUDE.md");
  expect(!has(got, M.hook) && !existsSync(hookRan), "adapter: the user hook does not run");
  console.log(`(cost $${cost.toFixed(3)}, ${model})`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
