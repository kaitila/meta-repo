import { expect, test } from "bun:test";
import { parseCss, resolveStyles, stripComments, substitute } from "../src";
import { parseTokens } from "../src/tokens";

test("blocks, declarations and line numbers; braces and semicolons in strings and url() don't split", () => {
  const blocks = parseCss(`/* a { } */
.a { color: var(--x); content: "}{;"; }
@media (min-width: 30em) {
  .b {
    background: url(data:image/png;base64,AA==);
  }
}`);
  expect(blocks.map((b) => [b.prelude, b.line])).toEqual([
    [".a", 2],
    ["@media (min-width: 30em)", 3],
  ]);
  expect(blocks[0]!.decls).toEqual([
    { prop: "color", value: "var(--x)", line: 2 },
    { prop: "content", value: '"}{;"', line: 2 },
  ]);
  expect(blocks[1]!.children[0]!.decls[0]).toEqual({ prop: "background", value: "url(data:image/png;base64,AA==)", line: 5 });
  expect(() => parseCss(".a { color: red")).toThrow("unclosed");
  expect(() => parseCss(".a { } }")).toThrow('unexpected "}"');
});

test("stripComments keeps line numbers; line comments only in JS, never inside a URL or a string", () => {
  expect(stripComments("a /* x\ny */ b")).toBe("a     \n     b");
  expect(stripComments('x // "#fff"\nu = "https://e.x/#abc" // c', { lineComments: true })).toBe('x          \nu = "https://e.x/#abc"     ');
  expect(stripComments("a // b")).toBe("a // b");
});

test("substitute fills var() recursively, with fallbacks, and leaves unknown names", () => {
  const env = { a: "var(--b)", b: "#123456", gap: "1rem" };
  const uses = new Set<string>();
  expect(substitute("var(--a) var(--gap)", env, uses)).toBe("#123456 1rem");
  expect([...uses].sort()).toEqual(["a", "b", "gap"]);
  expect(substitute("var(--nope, var(--gap))", env)).toBe("1rem");
  expect(substitute("var(--nope)", env)).toBe("var(--nope)");
  expect(substitute("calc(var(--gap) * 2)", env)).toBe("calc(1rem * 2)");
  expect(() => substitute("var(--loop)", { loop: "var(--loop)" })).toThrow("cycle");
});

test("resolveStyles resolves each declaration in the chosen scheme, including a rule's own custom properties", () => {
  const tokens = parseTokens(":root { --ink: #111; --gap: 1rem } @media (prefers-color-scheme: dark) { :root { --ink: #eee } }");
  const css = ".a { --pad: calc(var(--gap) * 2); color: var(--ink); padding: var(--pad) } @media (min-width: 30em) { .a { margin: var(--gap) } }";
  const light = resolveStyles(css, tokens);
  expect(light.map((d) => [d.where, d.prop, d.value])).toEqual([
    [".a", "--pad", "calc(1rem * 2)"],
    [".a", "color", "#111"],
    [".a", "padding", "calc(1rem * 2)"],
    ["@media (min-width: 30em) > .a", "margin", "1rem"],
  ]);
  expect(light[2]!.uses).toEqual(["gap"]);
  expect(resolveStyles(css, tokens, "dark").find((d) => d.prop === "color")!.value).toBe("#eee");
});
