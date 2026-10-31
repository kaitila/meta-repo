// The design lint: outside the tokens file, a stylesheet or component names tokens,
// never raw values. It fails on hex/rgb/hsl (and the other colour functions), on px
// lengths, and on var(--x) when --x isn't a token.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { type Block, parseCss, stripComments } from "./css";
import { GENERATED, parseTokens } from "./tokens";

export type Rule = "raw-color" | "raw-px" | "unknown-token";

export interface Finding {
  file: string;
  line: number;
  rule: Rule;
  /** The offending text, e.g. `#ff0000` or `12px`. */
  text: string;
}

export const EXTENSIONS = new Set([".css", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".html"]);
/** A line holding this marker is skipped: for the rare value that can't be a token. Say why next to it. */
export const ALLOW = "design-lint-allow";

const HEX = /(?<![\w&#/])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const COLOR_FN = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g;
const PX = /(?<![\w.-])(\d*\.\d+|\d+)px\b/g;
const VAR = /var\(\s*--([\w-]+)/g;

function scan(text: string, line: number, tokens: Set<string> | undefined, file: string, out: Finding[], colors = true) {
  if (colors) {
    for (const m of text.matchAll(HEX)) out.push({ file, line, rule: "raw-color", text: m[0] });
    for (const m of text.matchAll(COLOR_FN)) out.push({ file, line, rule: "raw-color", text: m[0] });
  }
  for (const m of text.matchAll(PX)) if (Number(m[1]) !== 0) out.push({ file, line, rule: "raw-px", text: m[0] });
  if (tokens) for (const m of text.matchAll(VAR)) if (!tokens.has(m[1]!)) out.push({ file, line, rule: "unknown-token", text: `--${m[1]}` });
}

/** Findings in one file's text. `tokens` (names without `--`) turns on the unknown-token rule. */
export function lintText(file: string, text: string, tokens?: Set<string>): Finding[] {
  if (text.startsWith(GENERATED)) return [];
  const allowed = new Set(text.split("\n").flatMap((l, i) => (l.includes(ALLOW) ? [i + 1] : [])));
  const out: Finding[] = [];
  if (extname(file) === ".css") {
    // Only values and at-rule conditions: `#add` in a selector is an id, not a colour.
    const blocks = parseCss(text);
    // A custom property the file defines itself (`--gap: var(--space-2)`) is known too; its value is checked like any other.
    let known = tokens;
    if (tokens) {
      known = new Set(tokens);
      const collect = (bs: Block[]): void => bs.forEach((b) => (b.decls.forEach((d) => d.prop.startsWith("--") && known!.add(d.prop.slice(2))), collect(b.children)));
      collect(blocks);
    }
    const walk = (bs: Block[]) => {
      for (const b of bs) {
        if (b.prelude.startsWith("@")) scan(b.prelude, b.line, known, file, out, false);
        for (const d of b.decls) d.value.split("\n").forEach((v, i) => scan(v, d.line + i, known, file, out));
        walk(b.children);
      }
    };
    walk(blocks);
  } else {
    stripComments(text, { lineComments: true })
      .split("\n")
      .forEach((l, i) => scan(l, i + 1, tokens, file, out));
  }
  return out.filter((f) => !allowed.has(f.line));
}

function* files(path: string): Generator<string> {
  const st = statSync(path);
  if (st.isFile()) {
    yield path;
    return;
  }
  for (const f of new Bun.Glob("**/*").scanSync({ cwd: path, onlyFiles: true })) {
    if (f.split("/").some((p) => p === "node_modules" || p.startsWith("."))) continue;
    if (EXTENSIONS.has(extname(f))) yield join(path, f);
  }
}

export interface LintResult {
  findings: Finding[];
  files: number;
  tokensFile?: string;
}

/**
 * Lint every CSS, TS/TSX, JS and HTML file under `paths`. The tokens file (by default the
 * first `tokens.css` found) is skipped and gives the list of known tokens, as is any file
 * design-kit generated.
 */
export function lint(paths: string[], opts: { tokensFile?: string; cwd?: string } = {}): LintResult {
  const cwd = opts.cwd ?? process.cwd();
  const all = [...new Set(paths.flatMap((p) => [...files(join(cwd, p))]))].sort();
  const tokensFile = opts.tokensFile ? join(cwd, opts.tokensFile) : all.find((f) => basename(f) === "tokens.css");
  if (opts.tokensFile && !existsSync(tokensFile!)) throw new Error(`tokens file not found: ${opts.tokensFile}`);
  const tokens = tokensFile ? new Set(parseTokens(readFileSync(tokensFile, "utf8")).names) : undefined;
  const findings: Finding[] = [];
  let count = 0;
  for (const f of all) {
    if (f === tokensFile || basename(f) === "tokens.css") continue;
    count++;
    findings.push(...lintText(relative(cwd, f), readFileSync(f, "utf8"), tokens));
  }
  return { findings, files: count, tokensFile: tokensFile && relative(cwd, tokensFile) };
}
