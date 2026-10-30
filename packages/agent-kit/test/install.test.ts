import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install, mergeSettings, TEMPLATES } from "../src/install";

const dir = mkdtempSync(join(tmpdir(), "agent-kit-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const baseline = JSON.parse(readFileSync(join(TEMPLATES, ".claude", "settings.json"), "utf8"));

test("the baseline denies the things D0003 says it must", () => {
  const deny: string[] = baseline.permissions.deny;
  for (const rule of [
    "Bash(git push * main)",
    "Bash(git push --force *)",
    "Bash(git commit --no-verify*)",
    "Bash(rm -rf *)",
    "Read(**/.env)",
    "Read(**/.env.local)",
  ]) {
    expect(deny).toContain(rule);
  }
  // Write(...) rules never match in Claude Code; Edit/Read cover the file tools.
  expect(JSON.stringify(baseline)).not.toContain("Write(");
  // No rule is both allowed and denied.
  expect(baseline.permissions.allow.filter((r: string) => deny.includes(r))).toEqual([]);
});

test("a fresh repo gets the templates", () => {
  const target = join(dir, "fresh");
  mkdirSync(target);
  const r = install(target);
  expect(r.created).toContain(join(".claude", "settings.json"));
  expect(JSON.parse(readFileSync(join(target, ".claude", "settings.json"), "utf8"))).toEqual(baseline);
});

test("an existing settings file keeps its rules and gains the baseline's; nothing is overwritten", () => {
  const target = join(dir, "existing");
  mkdirSync(join(target, ".claude"), { recursive: true });
  const mine = { model: "opus", permissions: { allow: ["Bash(make *)"], deny: ["Bash(git push * main)"] } };
  writeFileSync(join(target, ".claude", "settings.json"), JSON.stringify(mine));
  const r = install(target);
  expect(r.merged).toEqual([join(".claude", "settings.json")]);
  const after = JSON.parse(readFileSync(join(target, ".claude", "settings.json"), "utf8"));
  expect(after.model).toBe("opus");
  expect(after.permissions.allow[0]).toBe("Bash(make *)");
  expect(after.permissions.deny.filter((x: string) => x === "Bash(git push * main)").length).toBe(1);
  expect(after.permissions.deny).toContain("Read(**/.env)");
  // a second run changes nothing
  expect(install(target).merged).toEqual([]);
});

test("mergeSettings counts what it adds", () => {
  expect(mergeSettings(baseline, baseline).added).toBe(0);
  expect(mergeSettings({}, baseline).added).toBeGreaterThan(30);
});
