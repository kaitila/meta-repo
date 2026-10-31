// docs-check: keep a repository's docs true to its code. Built-in checks:
//   links      relative links and #anchors resolve
//   paths      backticked repo paths (`src/x.ts`) exist
//   decisions  one file per decision: names, headings, numbering, status grammar, sections, index
//   refs       every Dnnnn mentioned is a real decision
//   reviewed   "Last reviewed: YYYY-MM-DD (through Dnnnn)" lines are well-formed and fresh
//   registries opt-in code↔doc lists (env vars, CLI commands, ...)
// A line ending in <!-- docs-check: planned|removed|elsewhere --> skips its link and path checks.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { DEFAULT_DECISIONS, type Decision, type DecisionOptions, pad, parseDecisions, renderIndex } from "./decisions";
import { anchors, codeSpans, links, proseLines, withoutCode } from "./markdown";

export { parseDecisions, renderIndex, type Decision } from "./decisions";
export { envRegistry, firstCellKeys } from "./registries";

export interface Failure {
  file: string;
  line: number;
  kind: string;
  target: string;
  severity: "error" | "warning";
}

export interface Ctx {
  root: string;
  files: string[];
  exists(p: string): boolean;
  read(p: string): string | undefined;
  decisions: Decision[];
}

export interface Registry {
  /** Used in failure kinds: `<name>-undocumented`, `<name>-unknown`. */
  name: string;
  /** The doc that must list the keys. */
  doc: string;
  /** Keys the code defines or reads. `required` ones must be documented. */
  fromCode(ctx: Ctx): { key: string; required: boolean; file: string; line: number }[];
  /** Keys the doc lists (default: backticked names in the first cell of table rows). */
  fromDoc?(text: string): { key: string; line: number }[];
  /** Also fail on documented keys the code doesn't know (default true). */
  bidirectional?: boolean;
}

export interface Config {
  /** Markdown files to check (default every tracked *.md). */
  include?: string;
  exclude?: string[];
  decisions?: false | Partial<DecisionOptions> & { index?: string | false };
  reviewed?: false | { maxDays?: number };
  registries?: Registry[];
}

export const defineConfig = (c: Config) => c;

const IGNORE = /<!--\s*docs-check:\s*(?:planned|removed|elsewhere)\s*-->/;
const DEFAULT_EXCLUDE = ["node_modules/**", "**/node_modules/**", ".claude/worktrees/**"];

/** Tracked and untracked-but-not-ignored files, from git; a plain walk outside a repo. */
export function listFiles(root: string): string[] {
  const p = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode === 0) return p.stdout.toString().split("\0").filter((f) => f && existsSync(join(root, f)));
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(join(root, d), { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const rel = d ? `${d}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      else out.push(rel);
    }
  };
  walk("");
  return out;
}

export async function loadConfig(root: string): Promise<Config> {
  for (const name of ["docs-check.config.ts", "docs-check.config.js"]) {
    const f = join(root, name);
    if (existsSync(f)) return ((await import(f)) as { default: Config }).default ?? {};
  }
  return {};
}

export interface RunOptions {
  today?: Date;
  strictFreshness?: boolean;
}

export function run(root: string, config: Config = {}, opts: RunOptions = {}): { failures: Failure[]; decisions: Decision[]; files: number; index?: { path: string; text: string } } {
  const today = opts.today ?? new Date();
  const files = listFiles(root);
  const set = new Set<string>();
  for (const f of files) {
    set.add(f);
    for (let d = dirname(f); d !== "." && d !== "/"; d = dirname(d)) set.add(d);
  }
  const cache = new Map<string, string | undefined>();
  const read = (p: string) => {
    if (!cache.has(p)) cache.set(p, set.has(p) && statSync(join(root, p)).isFile() ? readFileSync(join(root, p), "utf8") : undefined);
    return cache.get(p);
  };
  const exists = (p: string) => p === "" || set.has(p.replace(/\/$/, ""));
  const failures: Failure[] = [];
  const fail = (file: string, line: number, kind: string, target: string, severity: Failure["severity"] = "error") =>
    failures.push({ file, line, kind, target, severity });

  const exclude = [...DEFAULT_EXCLUDE, ...(config.exclude ?? [])].map((g) => new Bun.Glob(g));
  const include = new Bun.Glob(config.include ?? "**/*.md");
  const docs = files.filter((f) => include.match(f) && !exclude.some((g) => g.match(f)));
  const topDirs = new Set(files.filter((f) => f.includes("/")).map((f) => f.split("/")[0]!));

  // ---- decisions ----
  let decisions: Decision[] = [];
  let index: { path: string; text: string } | undefined;
  const dopts: DecisionOptions | null = config.decisions === false ? null : { ...DEFAULT_DECISIONS, ...(config.decisions ?? {}) };
  if (dopts) {
    const dfiles = files.filter((f) => dirname(f) === dopts.dir && /^D\d/.test(f.split("/").pop()!) && f.endsWith(".md"));
    const parsed = parseDecisions(dfiles.map((file) => ({ file, text: read(file) ?? "" })), dopts, today);
    decisions = parsed.decisions;
    for (const f of parsed.failures) fail(f.file, f.line, f.kind, f.target);
    const indexFile = config.decisions && config.decisions.index === false ? null : `${dopts.dir}/${(config.decisions && config.decisions.index) || "README.md"}`;
    if (indexFile && decisions.length) {
      index = { path: indexFile, text: renderIndex(decisions, dopts) };
      const have = read(indexFile);
      if (have === undefined) fail(indexFile, 0, "decision-index", "missing; run docs-check --write-index");
      else if (have !== index.text) fail(indexFile, 0, "decision-index", "out of date; run docs-check --write-index");
    }
  }
  const known = new Set(decisions.map((d) => d.n));
  const width = dopts?.pad ?? 4;
  const refRe = new RegExp(`\\bD(\\d{${width}})\\b`, "g");

  // ---- per markdown file ----
  const anchorCache = new Map<string, Set<string>>();
  const anchorsOf = (f: string) => {
    if (!anchorCache.has(f)) anchorCache.set(f, anchors(read(f) ?? ""));
    return anchorCache.get(f)!;
  };
  for (const file of docs) {
    const lines = proseLines(read(file) ?? "");
    lines.forEach((line, i) => {
      const n = i + 1;
      const skip = IGNORE.test(line);
      if (!skip) {
        for (const target of links(withoutCode(line))) {
          if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue; // external
          const [pathPart, anchor] = target.split("#", 2) as [string, string | undefined];
          let decoded: string;
          try {
            decoded = decodeURIComponent(pathPart.split("?")[0]!);
          } catch {
            fail(file, n, "link", target);
            continue;
          }
          const resolved = decoded === "" ? file : normalize(decoded.startsWith("/") ? decoded.slice(1) : join(dirname(file), decoded)).replace(/\/$/, "");
          if (resolved.startsWith("..")) {
            fail(file, n, "link", `${target} (outside the repo)`);
            continue;
          }
          if (!exists(resolved)) {
            fail(file, n, "link", target);
            continue;
          }
          if (anchor && resolved.endsWith(".md") && !anchorsOf(resolved).has(decodeURIComponent(anchor).toLowerCase())) {
            fail(file, n, "link-anchor", target);
          }
        }
        for (const span of codeSpans(line)) {
          const p = span.replace(/:\d+(?:-\d+)?(?:,\s*\d+(?:-\d+)?)*$/, "").replace(/^\.\//, "");
          if (/[\s*?<>{}$…]|\.\./.test(p) || !p.includes("/")) continue; // not a plain repo path
          if (!topDirs.has(p.split("/")[0]!)) continue;
          if (!exists(p)) fail(file, n, "path", p);
        }
      }
      if (dopts) {
        for (const m of line.matchAll(refRe)) {
          if (!known.has(Number(m[1]))) fail(file, n, "decision-ref", `D${m[1]}`);
        }
      }
      if (config.reviewed !== false && /^[\s>*_#-]*Last reviewed:/.test(line)) {
        const rm = /Last reviewed:\**\s*(\d{4}-\d{2}-\d{2})\b.*?\bthrough D(\d+)\b/.exec(line);
        if (!rm) {
          fail(file, n, "reviewed", "write it as 'Last reviewed: YYYY-MM-DD (through Dnnnn)'");
          return;
        }
        const [, date, through] = rm;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date!) || date! > today.toISOString().slice(0, 10)) fail(file, n, "reviewed", `${date} is in the future`);
        if (dopts && !known.has(Number(through))) fail(file, n, "reviewed", `D${pad(Number(through), width)} doesn't exist`);
        const days = (today.getTime() - new Date(`${date}T00:00:00Z`).getTime()) / 86_400_000;
        const max = (config.reviewed && config.reviewed.maxDays) || 90;
        if (days > max) fail(file, n, "reviewed", `${Math.floor(days)} days old (max ${max})`, opts.strictFreshness ? "error" : "warning");
      }
    });
  }

  // ---- registries ----
  const ctx: Ctx = { root, files, exists, read, decisions };
  for (const r of config.registries ?? []) {
    const docText = read(r.doc);
    if (docText === undefined) {
      fail(r.doc, 0, `${r.name}-doc`, "missing");
      continue;
    }
    const inCode = r.fromCode(ctx);
    const inDoc = (r.fromDoc ?? firstCellKeysLocal)(docText);
    const documented = new Set(inDoc.map((d) => d.key));
    const knownKeys = new Set(inCode.map((c) => c.key));
    const reported = new Set<string>();
    for (const c of inCode) {
      if (c.required && !documented.has(c.key) && !reported.has(c.key)) {
        reported.add(c.key);
        fail(c.file, c.line, `${r.name}-undocumented`, `${c.key} (add it to ${r.doc})`);
      }
    }
    if (r.bidirectional !== false) for (const d of inDoc) if (!knownKeys.has(d.key)) fail(r.doc, d.line, `${r.name}-unknown`, d.key);
  }

  failures.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { failures, decisions, files: docs.length, index };
}

/** Backticked names in the first cell of markdown table rows. */
function firstCellKeysLocal(text: string): { key: string; line: number }[] {
  const out: { key: string; line: number }[] = [];
  text.split("\n").forEach((l, i) => {
    const cell = /^\s*\|([^|]*)\|/.exec(l)?.[1];
    if (!cell) return;
    for (const s of codeSpans(cell)) out.push({ key: s.split(/\s/)[0]!, line: i + 1 });
  });
  return out;
}

export const relativeTo = (root: string, p: string) => relative(root, p);
