// Ready-made registries. A registry ties a list in the code to a list in a doc, so
// neither drifts: every env var the code reads is documented, and the doc lists nothing
// the code doesn't read. Extraction is by regex over the source; pair it with a test in
// your app that compares the regex's answer with the real list, so it stays honest.
import type { Ctx, Registry } from "./index";
import { codeSpans } from "./markdown";

const KEY = "[A-Z][A-Z0-9_]*";

/** Backticked names in the first cell of markdown table rows. */
export function firstCellKeys(text: string): { key: string; line: number }[] {
  const out: { key: string; line: number }[] = [];
  text.split("\n").forEach((l, i) => {
    const cell = /^\s*\|([^|]*)\|/.exec(l)?.[1];
    if (!cell) return;
    for (const s of codeSpans(cell)) out.push({ key: s.split(/\s/)[0]!, line: i + 1 });
  });
  return out;
}

export interface EnvRegistryOptions {
  /** Doc with a table whose first column lists the variables, e.g. docs/configuration.md. */
  doc: string;
  /** Source files whose env reads must be documented (default every .ts/.tsx/.js outside tests and `.claude/`). */
  sources?: string;
  /** Files whose env reads are known but needn't be documented (tests, scripts). */
  knownSources?: string;
  /** Example files whose keys must all be real (default .env.example). */
  examples?: string[];
}

/** Environment variables: `process.env.X`, `process.env["X"]`, `Bun.env.X`. */
export function envRegistry(opts: EnvRegistryOptions): Registry {
  const read = new RegExp(`\\b(?:process|Bun|import\\.meta)\\.env(?:\\.(${KEY})|\\[\\s*["'\`](${KEY})["'\`]\\s*\\])`, "g");
  const sources = new Bun.Glob(opts.sources ?? "**/*.{ts,tsx,js,mjs}");
  const known = opts.knownSources ? new Bun.Glob(opts.knownSources) : null;
  const isTest = (f: string) => /(^|\/)(test|tests|__tests__)\/|\.test\.[jt]sx?$/.test(f);
  return {
    name: "env",
    doc: opts.doc,
    fromCode(ctx: Ctx) {
      const out: { key: string; required: boolean; file: string; line: number }[] = [];
      for (const f of ctx.files) {
        // Agent tooling (.claude/hooks reads Claude Code's and foreman's variables) isn't the app's config.
        if (f.includes("node_modules/") || f.startsWith(".claude/")) continue;
        const required = sources.match(f) && !isTest(f);
        if (!required && !(known?.match(f) || (sources.match(f) && isTest(f)))) continue;
        const text = ctx.read(f) ?? "";
        text.split("\n").forEach((l, i) => {
          for (const m of l.matchAll(read)) out.push({ key: (m[1] ?? m[2])!, required: Boolean(required), file: f, line: i + 1 });
        });
      }
      for (const ex of opts.examples ?? [".env.example"]) {
        const text = ctx.read(ex);
        if (text === undefined) continue;
        // Keys in an example file count as known only if the code reads them: checked below.
        text.split("\n").forEach((l, i) => {
          const m = new RegExp(`^\\s*#?\\s*(${KEY})=`).exec(l);
          if (m && !out.some((o) => o.key === m[1])) out.push({ key: `${m[1]} (in ${ex}, never read)`, required: true, file: ex, line: i + 1 });
        });
      }
      return out;
    },
  };
}
