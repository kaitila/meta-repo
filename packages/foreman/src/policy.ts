// Which tasks need a person (D0008). A task is "auto" (merges once a fresh verifier
// passes it) unless it touches protected paths: the guardrails, CI and foreman itself.
// Agents must not approve changes to their own limits.
//
// The files a branch really changed decide, not what the task declared: a passing
// verdict on an "auto" task is escalated to a person if the diff touches a protected
// path, or if the diff can't be worked out (fail closed).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Used when the repo has no foreman.json. */
export const DEFAULT_PROTECTED = [
  ".claude/**",
  "**/.claude/**",
  ".github/**",
  ".mcp.json",
  "foreman.json",
];

export interface Policy {
  protectedPaths: string[];
  /** Files the task's branch changed relative to main, or null if unknown. */
  changedFiles(branch: string | null): string[] | null;
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

function git(root: string, args: string[]): string | null {
  const p = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return p.exitCode === 0 ? p.stdout.toString().trim() : null;
}

export function gitPolicy(root: string | null): Policy {
  return {
    protectedPaths: loadProtected(root),
    changedFiles(branch) {
      if (!root || !branch) return null;
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
