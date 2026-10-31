// examples/demo-app is what presets/generate.ts makes from presets/bun-ts-postgres, so
// the two can't drift. After changing the preset:
//   bun presets/generate.ts bun-ts-postgres examples/demo-app --force
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generate } from "../generate";

const repo = join(import.meta.dir, "..", "..");
const demo = join(repo, "examples", "demo-app");

/** The demo's files as git sees them (tracked, or new and not ignored). */
function demoFiles(): Map<string, string> {
  const p = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "."], { cwd: demo, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ls-files failed: ${p.stderr.toString()}`);
  const files = p.stdout.toString().split("\0").filter(Boolean);
  return new Map(files.filter((f) => existsSync(join(demo, f))).map((f) => [f, readFileSync(join(demo, f), "utf8")]));
}

test("examples/demo-app is exactly the bun-ts-postgres preset generated as demo-app", () => {
  const want = generate(join(repo, "presets", "bun-ts-postgres"), "demo-app");
  const have = demoFiles();
  const fix = "run: bun presets/generate.ts bun-ts-postgres examples/demo-app --force";
  expect([...have.keys()].filter((f) => !want.has(f)), `files only in the demo (delete them, or add them to the preset; ${fix})`).toEqual([]);
  expect([...want.keys()].filter((f) => !have.has(f)), `files missing from the demo (${fix})`).toEqual([]);
  for (const [f, text] of want) expect(have.get(f), `${f} differs from the preset (${fix})`).toBe(text);
});

test("placeholders are filled in and names are checked", () => {
  const files = generate(join(repo, "presets", "bun-ts-postgres"), "my-app");
  expect(JSON.parse(files.get("package.json")!).name).toBe("my-app");
  expect(files.get("test/setup.ts")).toContain("/my_app_test");
  for (const [f, text] of files) expect(`${f}\n${text}`, f).not.toMatch(/\{\{\w+\}\}/);
  expect(() => generate(join(repo, "presets", "bun-ts-postgres"), "My App")).toThrow("name must be");
});
