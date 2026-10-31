import { expect, test } from "bun:test";
import { join } from "node:path";

const installed = (() => {
  try {
    Bun.resolveSync("playwright-core", join(import.meta.dir, "..", "src"));
    return true;
  } catch {
    return false;
  }
})();

test.skipIf(installed)("without playwright-core, screenshot says how to get it and exits 3", () => {
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "screenshot", "http://127.0.0.1:9/"], { stdout: "pipe", stderr: "pipe" });
  expect(p.exitCode).toBe(3);
  expect(p.stderr.toString()).toContain("playwright-core is not installed");
});

test("screenshot rejects a width that isn't one", () => {
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "screenshot", "http://127.0.0.1:9/", "--widths", "390,wide"], { stdout: "pipe", stderr: "pipe" });
  expect(p.exitCode).toBe(2);
  expect(p.stderr.toString()).toContain('not a width in CSS pixels: "wide"');
});
