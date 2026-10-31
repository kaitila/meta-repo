#!/usr/bin/env bun
// Live test of foreman's launch adapter (D0011) against real Claude Code.
// Builds a fake home with a global ~/.claude/CLAUDE.md, a ~/CLAUDE.md and a user
// hook, each carrying its own marker, and a git repo below it whose CLAUDE.md has
// a project marker, a project PreToolUse hook (like the guard hook), and
// .claude/rules/ files above the repo. Then:
//   1. control: a plain `claude -p` in the repo, with HOME pointed at the fake home,
//      must see the global markers (else this test proves nothing);
//   2. adapter: a verifier session started by launch() must see only the project
//      marker, the user hook must not run, the project hook must, and the login
//      symlink must still be a symlink afterwards.
// Needs a logged-in `claude` (~/.claude/.credentials.json); a few cents with Haiku.
// Not run in CI. Exit 0 = every expectation held.
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { credentialsLinkIntact, launch, StreamParser, STRIPPED_ENV } from "../src/launch";

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
  userRules: `ZQX-USERRULES-${tag}`, // ~/.claude/rules/
  ancestorRules: `ZQX-ANCESTORRULES-${tag}`, // ~/work/.claude/rules/, above the repo
};
const hookRan = join(dir, "hook-ran");
const projectHookRan = join(dir, "project-hook-ran");

let failed = 0;
const expect = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failed++;
};

const prompt =
  "This is an authorised test. First read README.md with the Read tool. Then list every token of the form ZQX-<WORD>-<CODE> that appears anywhere in your " +
  "instructions, project or user memory, CLAUDE.md files, or other context you were given, other than this " +
  "message's description of the pattern. Answer with the structured output.";
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
  writeFileSync(join(repo, "README.md"), "# Demo\n\nNothing to see here.\n");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(
    join(repo, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: `touch ${projectHookRan}` }] }] } }),
  );
  mkdirSync(join(home, ".claude", "rules"), { recursive: true });
  writeFileSync(join(home, ".claude", "rules", "user.md"), `# User rule\n\nThe user rule code word is ${M.userRules}.\n`);
  mkdirSync(join(home, "work", ".claude", "rules"), { recursive: true });
  writeFileSync(join(home, "work", ".claude", "rules", "work.md"), `# Work rule\n\nThe work rule code word is ${M.ancestorRules}.\n`);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIPPED_ENV.includes(k)) env[k] = v;
  delete env.CLAUDE_CONFIG_DIR;
  env.HOME = home;

  // 1. Control: what a plain session in this repo sees.
  const plain = Bun.spawnSync(
    ["claude", "-p", "--model", model, "--max-turns", "6", "--output-format", "stream-json", "--verbose",
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
  console.log(`control: rules seen: user ${has(seen, M.userRules)}, above the repo ${has(seen, M.ancestorRules)}; project hook ran: ${existsSync(projectHookRan)}`);
  rmSync(hookRan, { force: true });
  rmSync(projectHookRan, { force: true });

  // 2. A verifier started by the adapter.
  const r = await launch({
    role: "verifier",
    taskId: "T-LIVE",
    cwd: repo,
    prompt,
    model,
    maxTurns: 6,
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
  expect(!has(got, M.userRules) && !has(got, M.ancestorRules), "adapter: no .claude/rules/ from above the repo");
  expect(existsSync(projectHookRan), "adapter: the project's own PreToolUse hook runs (the guard hook would too)");
  expect(
    credentialsLinkIntact(join(dir, "claude-config")) && r.warnings.length === 0,
    "adapter: the login is still a symlink, not a copy",
  );
  console.log(`(cost $${cost.toFixed(3)}, ${model})`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
