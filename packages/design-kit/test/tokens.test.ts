import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contrast, generateTs, parseTokens } from "../src";

const PKG = join(import.meta.dir, "..");
const css = readFileSync(join(PKG, "tokens.css"), "utf8");

describe("the default tokens", () => {
  const t = parseTokens(css);

  test("tokens.ts is generated from tokens.css and up to date", () => {
    expect(readFileSync(join(PKG, "tokens.ts"), "utf8"), "run: bun packages/design-kit/src/cli.ts tokens packages/design-kit/tokens.css").toBe(generateTs(t));
  });

  test("cover colour, type, space, radius and motion, in light and dark", () => {
    for (const prefix of ["color-", "font-", "text-", "leading-", "space-", "radius-", "duration-", "ease-"]) {
      expect(t.names.some((n) => n.startsWith(prefix)), prefix).toBe(true);
    }
    expect(t.dark["color-bg"]).not.toBe(t.light["color-bg"]);
    expect(t.dark["space-4"]).toBe(t.light["space-4"]);
    expect(t.reducedMotion["duration-base"]).toBe("0ms");
  });

  // AA: 4.5 for text, 3 for the edges of controls and the focus ring.
  const resolve = (v: Record<string, string>, n: string): string => (v[n]!.startsWith("var(") ? resolve(v, v[n]!.slice(6, -1)) : v[n]!);
  test.each(["light", "dark"] as const)("every text pair meets WCAG AA in %s", (scheme) => {
    const v = t[scheme];
    const pairs: [string, string, number][] = [
      ["color-ink", "color-bg", 4.5],
      ["color-ink", "color-surface", 4.5],
      ["color-ink-muted", "color-bg", 4.5],
      ["color-ink-muted", "color-surface", 4.5],
      ["color-danger", "color-surface", 4.5],
      ["color-on-accent", "color-accent", 4.5],
      ["color-on-accent", "color-accent-hover", 4.5],
      ["color-accent", "color-bg", 4.5],
      ["color-line-strong", "color-bg", 3],
      ["color-line-strong", "color-surface", 3],
      ["color-focus", "color-surface", 3],
    ];
    for (const [fg, bg, min] of pairs) expect(contrast(resolve(v, fg), resolve(v, bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
  });
});

describe("parseTokens", () => {
  test("dark overrides apply on top of light; tokens.ts resolves tokens that name tokens", () => {
    const t = parseTokens(":root { --a: #fff; --b: var(--a); --gap: 1rem }\n@media (prefers-color-scheme: dark) { :root { --a: #000 } }");
    expect(t.names).toEqual(["a", "b", "gap"]);
    expect(t.dark).toEqual({ a: "#000", b: "var(--a)", gap: "1rem" });
    const ts = generateTs(t);
    expect(ts).toContain('b: "var(--b)"');
    expect(ts).toMatch(/export const dark = \{\n {2}a: "#000",\n {2}b: "#000",/);
  });

  test("the format is strict, so the file stays a list of values", () => {
    expect(() => parseTokens(".x { --a: 1 }")).toThrow("exactly one top-level :root");
    expect(() => parseTokens(":root { --a: 1 } :root { --b: 2 }")).toThrow("exactly one");
    expect(() => parseTokens(":root { color: red }")).toThrow('not "color"');
    expect(() => parseTokens(":root { --a: 1; --a: 2 }")).toThrow("defined twice");
    expect(() => parseTokens(":root { --Big: 1 }")).toThrow("lower-case");
    expect(() => parseTokens(":root { --a: 1 } @media (prefers-color-scheme: dark) { :root { --b: 2 } }")).toThrow("--b overrides a token");
    expect(() => parseTokens(":root { --a: 1 } @media (min-width: 40em) { :root { --a: 2 } }")).toThrow("unexpected block");
    expect(() => parseTokens(":root { --a: 1 } @media (prefers-color-scheme: dark) { body { --a: 2 } }")).toThrow("only :root");
  });
});
