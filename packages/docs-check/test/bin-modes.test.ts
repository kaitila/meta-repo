import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const git = (...args: string[]) =>
  new TextDecoder().decode(Bun.spawnSync(["git", ...args], { cwd: root }).stdout);

// bun install chmods every "bin" target; a 100644 one shows as a mode change in every checkout.
const targets = readdirSync(join(root, "packages")).flatMap((pkg) => {
  let json: { bin?: string | Record<string, string> };
  try {
    json = JSON.parse(readFileSync(join(root, "packages", pkg, "package.json"), "utf8"));
  } catch {
    return [];
  }
  const bins = typeof json.bin === "string" ? [json.bin] : Object.values(json.bin ?? {});
  return bins.map((b) => `packages/${pkg}/${b.replace(/^\.\//, "")}`);
});

describe("package bin targets", () => {
  test("there are some", () => expect(targets.length).toBeGreaterThan(0));
  test.each([...new Set(targets)])("%s is 100755 in the index", (path) => {
    const out = git("ls-files", "-s", "--", path).trim();
    expect(out.split(/\s/)[0]).toBe("100755");
  });
});
