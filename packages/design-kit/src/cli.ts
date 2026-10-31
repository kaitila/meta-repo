#!/usr/bin/env bun
// design-kit tokens <tokens.css> [--out tokens.ts] [--check]
// design-kit lint [paths...] [--tokens tokens.css]
// design-kit screenshot <url> [--out dir] [--widths 390,1280] [--executable path]
// Exit codes: 0 clean, 1 findings (or tokens.ts out of date), 2 couldn't run, 3 no browser for screenshots.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { lint } from "./lint";
import { NoBrowser, screenshot } from "./screenshot";
import { generateTs, parseTokens } from "./tokens";

const USAGE = `usage:
  design-kit tokens <tokens.css> [--out tokens.ts] [--check]   write tokens.ts from tokens.css (--check: fail if it's out of date)
  design-kit lint [paths...] [--tokens tokens.css]             fail on raw colours, px and unknown tokens outside the tokens file
  design-kit screenshot <url> [--out dir] [--widths 390,1280] [--executable path]   PNGs at each width, light and dark (needs playwright-core)`;

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      check: { type: "boolean" },
      tokens: { type: "string" },
      widths: { type: "string" },
      executable: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...args] = positionals;
  if (values.help || !cmd) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 2);
  }
  if (cmd === "tokens") {
    if (args.length !== 1) throw new Error("tokens takes one tokens.css path");
    const src = resolve(args[0]!);
    const out = resolve(values.out ?? join(dirname(src), basename(src).replace(/\.css$/, "") + ".ts"));
    const text = generateTs(parseTokens(readFileSync(src, "utf8")), basename(src));
    if (values.check) {
      const current = existsSync(out) ? readFileSync(out, "utf8") : "";
      if (current !== text) {
        console.error(`design-kit: ${args[0]} changed but ${basename(out)} wasn't regenerated: run design-kit tokens ${args[0]}`);
        process.exit(1);
      }
      console.log(`design-kit: ${basename(out)} is up to date`);
    } else {
      writeFileSync(out, text);
      console.log(`wrote ${out}`);
    }
  } else if (cmd === "lint") {
    const result = lint(args.length ? args : ["."], { tokensFile: values.tokens });
    for (const f of result.findings) console.log(`${f.file}:${f.line}  ${f.rule}  ${f.text}`);
    const hint = result.findings.length ? " (use a token from the tokens file; add one there if none fits)" : "";
    console.log(`design-lint: ${result.files} files, ${result.findings.length} findings${hint}`);
    process.exit(result.findings.length ? 1 : 0);
  } else if (cmd === "screenshot") {
    if (args.length !== 1) throw new Error("screenshot takes one URL");
    const widths = values.widths?.split(",").map((w) => {
      const n = Number(w);
      if (!Number.isInteger(n) || n < 200) throw new Error(`--widths: not a width in CSS pixels: "${w}"`);
      return n;
    });
    try {
      const shots = await screenshot(args[0]!, { out: values.out ?? "screenshots", widths, executablePath: values.executable });
      for (const s of shots) console.log(`${s.path}  ${s.width} ${s.scheme}${s.overflowsX ? "  scrolls sideways" : ""}`);
    } catch (e) {
      if (!(e instanceof NoBrowser)) throw e;
      console.error(`design-kit: ${e.message}`);
      process.exit(3);
    }
  } else throw new Error(`unknown command "${cmd}"\n${USAGE}`);
} catch (e) {
  console.error(`design-kit: ${(e as Error).message}`);
  process.exit(2);
}
