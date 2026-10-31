// Pick the tests a change can affect, from the import graph. It over-selects, never
// under-selects: anything that changes how every test runs selects them all, and a
// test that names a changed file (a fixture, a SQL file) is picked too.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface AffectedOptions {
  root: string;
  /** Test files (default every *.test.ts / *.test.tsx). */
  testGlob?: string;
  /** Changed files (repo-relative). */
  changed: string[];
  /** A change matching any of these selects every test. */
  everything?: RegExp[];
  /** Tests that always run when anything changed. */
  always?: string[];
  /** Changed files never used for name matching (docs, by default). */
  noNameMatch?: RegExp[];
}

export const DEFAULT_EVERYTHING = [
  /(^|\/)package\.json$/,
  /(^|\/)bun\.lockb?$/,
  /(^|\/)bunfig\.toml$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /^\.github\/workflows\//,
  /(^|\/)test\/setup\.ts$/,
  /(^|\/)migrations\//,
];

export interface Affected {
  all: false | string; // the reason when everything is selected
  picked: Map<string, string>; // test → why
}

const transpiler = new Bun.Transpiler({ loader: "tsx" });

function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // packages and aliases: not followed
  const base = resolve(dirname(from), spec);
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

/** All local files a test imports, transitively, plus their comment-free source. */
function closure(entry: string): { files: Set<string>; code: string } {
  const files = new Set<string>();
  const code: string[] = [];
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (files.has(f)) continue;
    files.add(f);
    let src: string;
    try {
      src = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    try {
      code.push(transpiler.transformSync(src));
      for (const imp of transpiler.scanImports(src)) {
        const r = resolveImport(f, imp.path);
        if (r) stack.push(r);
      }
    } catch {
      code.push(src);
    }
  }
  return { files, code: code.join("\n") };
}

export function affectedTests(opts: AffectedOptions): Affected {
  const root = resolve(opts.root);
  const picked = new Map<string, string>();
  const changed = opts.changed.filter(Boolean);
  if (!changed.length) return { all: false, picked };
  const trigger = changed.find((c) => (opts.everything ?? DEFAULT_EVERYTHING).some((r) => r.test(c)));
  if (trigger) return { all: `${trigger} changes how every test runs`, picked };
  const tests = [...new Bun.Glob(opts.testGlob ?? "**/*.test.{ts,tsx}").scanSync({ cwd: root })].filter((t) => !t.includes("node_modules/")).sort();
  const noName = opts.noNameMatch ?? [/\.md$/];
  for (const t of tests) {
    const abs = join(root, t);
    const { files, code } = closure(abs);
    for (const c of changed) {
      const absC = join(root, c);
      if (files.has(absC)) {
        picked.set(t, absC === abs ? "changed" : `imports ${c}`);
        break;
      }
      if (noName.some((r) => r.test(c))) continue;
      const parts = c.split("/");
      const file = parts.pop()!;
      const needle = /\.(t|j)sx?$/.test(file) ? `${parts.pop() ?? ""}/${file.replace(/\.(t|j)sx?$/, "")}` : file;
      if (code.includes(needle)) {
        picked.set(t, `names ${c}`);
        break;
      }
    }
  }
  for (const a of opts.always ?? []) if (!picked.has(a)) picked.set(a, "always runs");
  return { all: false, picked };
}

/** Changed files: the merge base with `base` (default origin/main) up to HEAD, plus uncommitted and untracked work. */
export function changedFiles(root: string, base = "origin/main"): string[] {
  const git = (args: string[]) => {
    const p = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
    return p.stdout.toString().split("\n").filter(Boolean);
  };
  const mb = git(["merge-base", base, "HEAD"])[0]!;
  return [
    ...new Set([
      ...git(["diff", "--name-only", "--no-renames", mb, "HEAD"]),
      ...git(["diff", "--name-only", "--no-renames", "HEAD"]),
      ...git(["ls-files", "--others", "--exclude-standard"]),
    ]),
  ].map((f) => relative(root, join(root, f)));
}
