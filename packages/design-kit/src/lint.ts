// The design lint: outside the tokens file, a stylesheet or component names tokens,
// never raw values. It fails on hex/rgb/hsl (and the other colour functions), on CSS named
// colours (`red`; not `transparent`, `currentColor` or the CSS-wide keywords), on px
// lengths, and on var(--x) when --x isn't a token.
// Named colours are read in CSS declaration values (minus strings, url() and the properties
// that hold names, not colours) and, in JS/TS/HTML, only in a string that is clearly a style value.
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
const NAMED = new Set([
  "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque", "black", "blanchedalmond",
  "blue", "blueviolet", "brown", "burlywood", "cadetblue", "chartreuse", "chocolate", "coral", "cornflowerblue",
  "cornsilk", "crimson", "cyan", "darkblue", "darkcyan", "darkgoldenrod", "darkgray", "darkgreen", "darkgrey",
  "darkkhaki", "darkmagenta", "darkolivegreen", "darkorange", "darkorchid", "darkred", "darksalmon",
  "darkseagreen", "darkslateblue", "darkslategray", "darkslategrey", "darkturquoise", "darkviolet", "deeppink",
  "deepskyblue", "dimgray", "dimgrey", "dodgerblue", "firebrick", "floralwhite", "forestgreen", "fuchsia",
  "gainsboro", "ghostwhite", "gold", "goldenrod", "gray", "green", "greenyellow", "grey", "honeydew", "hotpink",
  "indianred", "indigo", "ivory", "khaki", "lavender", "lavenderblush", "lawngreen", "lemonchiffon",
  "lightblue", "lightcoral", "lightcyan", "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey",
  "lightpink", "lightsalmon", "lightseagreen", "lightskyblue", "lightslategray", "lightslategrey",
  "lightsteelblue", "lightyellow", "lime", "limegreen", "linen", "magenta", "maroon", "mediumaquamarine",
  "mediumblue", "mediumorchid", "mediumpurple", "mediumseagreen", "mediumslateblue", "mediumspringgreen",
  "mediumturquoise", "mediumvioletred", "midnightblue", "mintcream", "mistyrose", "moccasin", "navajowhite",
  "navy", "oldlace", "olive", "olivedrab", "orange", "orangered", "orchid", "palegoldenrod", "palegreen",
  "paleturquoise", "palevioletred", "papayawhip", "peachpuff", "peru", "pink", "plum", "powderblue", "purple",
  "rebeccapurple", "red", "rosybrown", "royalblue", "saddlebrown", "salmon", "sandybrown", "seagreen",
  "seashell", "sienna", "silver", "skyblue", "slateblue", "slategray", "slategrey", "snow", "springgreen",
  "steelblue", "tan", "teal", "thistle", "tomato", "turquoise", "violet", "wheat", "white", "whitesmoke",
  "yellow", "yellowgreen",
]);
/** A colour word on its own: not part of a longer word, `--token`, `.class` or `#id`, and not a function (`tan(`). */
const WORD = /(?<![\w.#$@-])[a-zA-Z]+(?![\w-]|\s*\()/g;
/** CSS properties whose values are names or idents, not colours: `font-family: Tan`, `grid-area: red`. */
const NAME_PROPS = /^(?:font|font-family|animation|animation-name|grid|grid-area|grid-row|grid-column|grid-(?:row|column)-(?:start|end)|grid-template|grid-template-areas|counter-(?:reset|increment|set)|will-change|transition-property|view-transition-name|container|container-name|list-style-type|quotes|src)$/;
/** Property names (CSS or JS-style) that carry a colour, for style values found in strings. */
const COLOR_PROP = /(?:color|background|border|outline|fill|stroke|shadow|decoration|column-?rule|gradient)/i;
const PX = /(?<![\w.-])(\d*\.\d+|\d+)px\b/g;
const VAR = /var\(\s*--([\w-]+)/g;

/** Named colours in a CSS value. Quoted strings, url() and the names inside var()/attr()/local()/counter() aren't read. */
function named(value: string): string[] {
  const v = value
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""')
    .replace(/\b(?:url|local|attr|counters?)\([^)]*\)/gi, "x()")
    .replace(/\bvar\(\s*--[\w-]+/gi, "var(");
  return [...v.matchAll(WORD)].map((m) => m[0]).filter((w) => NAMED.has(w.toLowerCase()));
}

/** Named colours in the strings of one JS/TS/HTML line: only `prop: value` style text, or a value right after a colour key (`fill="red"`, `color: "red"`). */
function namedInStrings(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)) {
    const decls = m[2]!.split(";").flatMap((part) => {
      const d = /^\s*([a-zA-Z-]+)\s*:\s*(.+)$/.exec(part);
      return d && COLOR_PROP.test(d[1]!) && !NAME_PROPS.test(d[1]!.toLowerCase()) ? [d[2]!] : [];
    });
    if (decls.length === 0 && /(?:color|background|border|outline|fill|stroke|shadow)\w*["']?\s*[:=]\s*$/i.test(line.slice(0, m.index))) decls.push(m[2]!);
    for (const d of decls) out.push(...named(d));
  }
  return out;
}

function scan(text: string, line: number, tokens: Set<string> | undefined, file: string, out: Finding[], colors = true, names = false) {
  if (names) for (const w of named(text)) out.push({ file, line, rule: "raw-color", text: w });
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
        for (const d of b.decls) d.value.split("\n").forEach((v, i) => scan(v, d.line + i, known, file, out, true, !NAME_PROPS.test(d.prop.toLowerCase())));
        walk(b.children);
      }
    };
    walk(blocks);
  } else {
    stripComments(text, { lineComments: true })
      .split("\n")
      .forEach((l, i) => {
        scan(l, i + 1, tokens, file, out);
        for (const w of namedInStrings(l)) out.push({ file, line: i + 1, rule: "raw-color", text: w });
      });
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
