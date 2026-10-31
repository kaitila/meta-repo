// Every route says how an agent reaches it: an MCP tool, or a reason it has none.
import { expect, test } from "bun:test";
import { routes } from "../src/server";

test("every route declares its MCP tool or why it has none", () => {
  expect(routes.length).toBeGreaterThan(0);
  for (const r of routes) {
    const where = `${r.method} ${r.path}`;
    expect(r.mcp, where).toBeDefined();
    if ("skip" in r.mcp) expect(r.mcp.skip.trim(), `${where}: skip needs a reason`).not.toBe("");
    else expect(r.mcp.description.trim(), `${where}: tool needs a description`).not.toBe("");
  }
});

test("tool names are snake_case and unique", () => {
  const tools = routes.flatMap((r) => ("tool" in r.mcp ? [r.mcp.tool] : []));
  for (const t of tools) expect(t).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
  expect(new Set(tools).size).toBe(tools.length);
});

test("no two routes share a method and path", () => {
  const keys = routes.map((r) => `${r.method} ${r.path}`);
  expect(new Set(keys).size).toBe(keys.length);
});
