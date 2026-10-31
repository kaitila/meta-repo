import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lint, lintText } from "../src";

const tokens = new Set(["color-ink", "space-2"]);
const rules = (file: string, text: string) => lintText(file, text, tokens).map((f) => `${f.line} ${f.rule} ${f.text}`);

describe("lintText", () => {
  test("a stylesheet that only names tokens is clean", () => {
    expect(rules("a.css", ".a { color: var(--color-ink); margin: 0 auto; padding: var(--space-2) 0; width: 100% }")).toEqual([]);
  });

  test("raw colours fail: hex, rgb, hsl and the other colour functions", () => {
    expect(rules("a.css", ".a {\n  color: #ff0000;\n  background: rgb(0 0 0 / 0.5);\n  border-color: hsla(0, 0%, 0%, 1);\n  fill: oklch(0.7 0.1 200);\n}")).toEqual([
      "2 raw-color #ff0000",
      "3 raw-color rgb(",
      "4 raw-color hsla(",
      "5 raw-color oklch(",
    ]);
  });

  test("named colours fail in CSS values, any case", () => {
    expect(rules("a.css", ".a {\n  color: red;\n  background: rebeccapurple;\n  border: 1px solid WHITE;\n}")).toEqual([
      "2 raw-color red",
      "3 raw-color rebeccapurple",
      "4 raw-color WHITE",
      "4 raw-px 1px",
    ]);
    expect(rules("a.css", ".a { color: DarkSlateGray; fill: grey; stroke: gray; background: linear-gradient(red, var(--color-ink, blue)) }")).toEqual([
      "1 raw-color DarkSlateGray",
      "1 raw-color grey",
      "1 raw-color gray",
      "1 raw-color red",
      "1 raw-color blue",
    ]);
  });

  test("allowed keywords and non-colour uses of colour words are clean", () => {
    const css = [
      ".red, .bordered > #white { transition: color 1s; color: inherit; background: transparent; border-color: currentColor; outline-color: CURRENTCOLOR }",
      ".b { color: var(--color-red); margin: calc(1rem * tan(1deg)); width: initial; height: unset; top: revert }",
      '.c { content: "red"; background: url(red.png); font-family: Tan, serif; animation-name: red; grid-area: white; --color-red: var(--color-ink) }',
      "@keyframes red { from { opacity: 0 } }",
      ".d { --token-name: reduce; quotes: tan }",
    ].join("\n");
    expect(rules("a.css", css)).toEqual([]);
  });

  test("a custom property holding a named colour fails", () => {
    expect(rules("a.css", ":root { --brand: tomato }")).toEqual(["1 raw-color tomato"]);
  });

  test("design-lint-allow skips a named colour", () => {
    expect(rules("a.css", ".a { color: red } /* design-lint-allow: brand match */\n.b { color: blue }")).toEqual(["2 raw-color blue"]);
  });

  test("in code, named colours count only in strings that are style values", () => {
    const ts = [
      "const red = 1; const white = red + 2; reduce(red);",
      'const kind = "red"; type T = "red" | "white"; log("Note: red");',
      "// color: red in a comment",
      'const a = { color: "red", backgroundColor: \'White\' };',
      'const b = "color: red; margin: 0";',
      "const c = `border: 1px solid ${x} blue`;",
      'const d = <div style="background: tomato" fill="navy" font-family="Tan" />;',
      'const e = "font-family: Tan; color: var(--color-ink)";',
    ].join("\n");
    expect(rules("a.tsx", ts)).toEqual([
      "4 raw-color red",
      "4 raw-color White",
      "5 raw-color red",
      "6 raw-px 1px",
      "6 raw-color blue",
      "7 raw-color tomato",
      "7 raw-color navy",
    ]);
    expect(rules("a.html", '<p style="color: red">x</p> <!-- design-lint-allow -->')).toEqual([]);
    expect(rules("a.html", '<p style="color: red">x</p>')).toEqual(["1 raw-color red"]);
  });

  test("px fails anywhere but 0, including in @media; rem, em and % are fine", () => {
    expect(rules("a.css", ".a { margin: 12px 0px 0 1.5px; padding: 1rem }\n@media (min-width: 600px) { .b { top: 1em } }")).toEqual([
      "1 raw-px 12px",
      "1 raw-px 1.5px",
      "2 raw-px 600px",
    ]);
  });

  test("an id selector that happens to be hex isn't a colour", () => {
    expect(rules("a.css", "#add, #fade { color: var(--color-ink) }")).toEqual([]);
  });

  test("var() must name a token, or a custom property the file defines", () => {
    expect(rules("a.css", ".a { color: var(--colour-ink) }")).toEqual(["1 unknown-token --colour-ink"]);
    expect(rules("a.css", ".a { --pad: var(--space-2); padding: var(--pad) }")).toEqual([]);
    expect(lintText("a.css", ".a { color: var(--anything) }")).toEqual([]); // no tokens file: rule off
  });

  test("TS and JS are checked line by line; comments are skipped, strings and URLs are not", () => {
    const ts = `// a comment with #ff0000\nconst style = { color: "#ff0000", padding: "4px" };\nconst url = "https://example.com/#fade"; /* rgb( */\nconst x = \`\${"#abc"}\`;`;
    expect(rules("Card.tsx", ts)).toEqual(["2 raw-color #ff0000", "2 raw-px 4px", "4 raw-color #abc"]);
  });

  test("a line with the allow marker is skipped", () => {
    expect(rules("a.css", ".a {\n  color: #fff; /* design-lint-allow: the vendor widget insists */\n}")).toEqual([]);
  });

  test("files design-kit generated are skipped", () => {
    expect(rules("tokens.ts", '// Generated by design-kit from tokens.css\nexport const light = { bg: "#fff" };')).toEqual([]);
  });
});

describe("lint over files, and the CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "design-lint-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "ui", "node_modules"), { recursive: true });
  writeFileSync(join(dir, "ui", "tokens.css"), ":root { --color-ink: #111; --space-2: 8px }");
  writeFileSync(join(dir, "ui", "app.css"), ".a { color: var(--color-ink) }");
  writeFileSync(join(dir, "ui", "node_modules", "x.css"), ".a { color: #123456 }");
  writeFileSync(join(dir, "ui", "notes.md"), "#ffffff");
  const cli = (...args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });

  test("the tokens file holds raw values and is skipped; node_modules and non-code files aren't read", () => {
    const r = lint(["ui"], { cwd: dir });
    expect(r).toEqual({ findings: [], files: 1, tokensFile: "ui/tokens.css" });
    expect(cli("lint", "ui").exitCode).toBe(0);
  });

  test("a raw hex added to a component fails the lint, naming file and line", () => {
    writeFileSync(join(dir, "ui", "Badge.tsx"), 'export const Badge = () => <span style={{ color: "#e11d48" }}>new</span>;\n');
    const p = cli("lint", "ui");
    expect(p.exitCode).toBe(1);
    expect(p.stdout.toString()).toContain("ui/Badge.tsx:1  raw-color  #e11d48");
    rmSync(join(dir, "ui", "Badge.tsx"));
  });

  test("tokens --check fails until tokens.ts is regenerated", () => {
    expect(cli("tokens", "ui/tokens.css", "--check").exitCode).toBe(1);
    expect(cli("tokens", "ui/tokens.css").exitCode).toBe(0);
    expect(cli("tokens", "ui/tokens.css", "--check").exitCode).toBe(0);
    writeFileSync(join(dir, "ui", "tokens.css"), ":root { --color-ink: #222; --space-2: 8px }");
    const stale = cli("tokens", "ui/tokens.css", "--check");
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr.toString()).toContain("wasn't regenerated");
  });

  test("bad input is exit 2", () => {
    expect(cli("lint", "ui", "--tokens", "missing.css").exitCode).toBe(2);
    expect(cli("nope").exitCode).toBe(2);
  });
});
