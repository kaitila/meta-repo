// Which tasks need a person (D0008). A task is "auto" (merges once a fresh verifier
// passes it) unless it touches protected paths: the guardrails, CI and foreman itself.
// Agents must not approve changes to their own limits.
//
// The files the PR really changes decide, not what the task declared or which branch
// the worker reports: a passing verdict on an "auto" task is escalated to a person if
// the diff touches a protected path, or if it can't be worked out or is empty (fail
// closed). A GitHub PR's own file list is used when the task's PR is a GitHub URL.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Used when the repo has no foreman.json. */
export const DEFAULT_PROTECTED = [
  ".claude/**",
  "**/.claude/**",
  ".github/**",
  ".mcp.json",
  "foreman.json",
  // What defines the checks and the agents' instructions.
  "package.json",
  "**/package.json",
  "bun.lock",
  "**/tsconfig*.json",
  "AGENTS.md",
  "**/AGENTS.md",
  "CLAUDE.md",
  "**/CLAUDE.md",
];

export interface Policy {
  protectedPaths: string[];
  /** Files the task's PR (or, without a GitHub PR, its branch) changes; null if unknown. */
  changedFiles(task: { branch: string | null; pr: string | null }): string[] | null;
}

export function loadProtected(root: string | null): string[] {
  if (!root) return DEFAULT_PROTECTED;
  const file = join(root, "foreman.json");
  if (!existsSync(file)) return DEFAULT_PROTECTED;
  const cfg = JSON.parse(readFileSync(file, "utf8")) as { protectedPaths?: string[] };
  // foreman.json guards itself, whatever it says.
  return [...new Set([...(cfg.protectedPaths ?? DEFAULT_PROTECTED), "foreman.json"])];
}

export function isProtected(file: string, protectedPaths: string[]): boolean {
  return protectedPaths.some((g) => new Bun.Glob(g).match(file));
}

/** The literal part of a glob before its first wildcard: "src/**" → "src/". */
const prefix = (g: string) => g.split(/[*?[{]/)[0]!;

/** Could a task with these declared paths touch a protected path? Errs towards yes. */
export function mayTouchProtected(paths: string[], protectedPaths: string[]): boolean {
  if (paths.length === 0) return false; // undeclared: the diff check at verdict time decides
  return paths.some((p) =>
    protectedPaths.some((q) => {
      const pp = prefix(p);
      const qp = prefix(q);
      if (new Bun.Glob(q).match(p) || new Bun.Glob(q).match(pp) || new Bun.Glob(p).match(qp)) return true;
      // Literal prefixes overlap ("packages/" vs "packages/foreman/src/"); an empty prefix
      // ("**/.claude/**") says nothing, the glob matches above handle it.
      return pp !== "" && qp !== "" && (pp.startsWith(qp) || qp.startsWith(pp));
    }),
  );
}

type Run = (cmd: string[], cwd: string) => string | null;

const defaultRun: Run = (cmd, cwd) => {
  try {
    const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    return p.exitCode === 0 ? p.stdout.toString().trim() : null;
  } catch {
    return null; // e.g. gh not installed
  }
};

export const GITHUB_PR = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\/?$/;

export function gitPolicy(root: string | null, run: Run = defaultRun): Policy {
  const git = (r: string, args: string[]) => run(["git", ...args], r);
  return {
    protectedPaths: loadProtected(root),
    changedFiles({ branch, pr }) {
      if (!root) return null;
      // The PR is what gets merged: ask GitHub for its files. A worker can't steer this
      // by recording some other branch.
      if (pr && GITHUB_PR.test(pr)) {
        const out = run(["gh", "pr", "diff", pr, "--name-only"], root);
        return out === null ? null : out.split("\n").filter(Boolean);
      }
      // No GitHub PR (local-only workflows): fall back to the recorded branch. Weaker,
      // because the worker names the branch (D0008).
      if (!branch) return null;
      const ref = [branch, `origin/${branch}`].find((r) => git(root, ["rev-parse", "--verify", "--quiet", r]));
      if (!ref) return null;
      const base = ["origin/main", "main", "origin/master", "master"]
        .map((b) => git(root, ["merge-base", b, ref]))
        .find((x) => x);
      if (!base) return null;
      const out = git(root, ["diff", "--name-only", "--no-renames", base, ref]);
      return out === null ? null : out.split("\n").filter(Boolean);
    },
  };
}
