import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { affectedTests } from "../src/affected";

const root = mkdtempSync(join(tmpdir(), "test-kit-affected-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const put = (f: string, s: string) => {
  mkdirSync(dirname(join(root, f)), { recursive: true });
  writeFileSync(join(root, f), s);
};
put("src/money.ts", "export const add = (a: number, b: number) => a + b;\n");
put("src/report.ts", 'import { add } from "./money";\nexport const total = () => add(1, 2);\n');
put("src/other.ts", "export const x = 1;\n");
put("test/fixtures/invoice.json", "{}\n");
put("test/report.test.ts", 'import { total } from "../src/report";\nimport "bun:test";\nconsole.log(total);\n');
put("test/other.test.ts", 'import { x } from "../src/other";\nconst f = "fixtures/invoice.json";\nconsole.log(x, f);\n');
put("test/docs.test.ts", "// always\n");

const pick = (changed: string[], extra = {}) => [...affectedTests({ root, changed, ...extra }).picked.keys()].sort();

test("a change picks the tests that import it, directly or through other files", () => {
  expect(pick(["src/money.ts"])).toEqual(["test/report.test.ts"]);
  expect(pick(["src/other.ts"])).toEqual(["test/other.test.ts"]);
});

test("a test that names a changed non-code file is picked", () => {
  expect(pick(["test/fixtures/invoice.json"])).toEqual(["test/other.test.ts"]);
});

test("changing a test picks it; docs pick nothing; 'always' tests join any change", () => {
  expect(pick(["test/report.test.ts"])).toEqual(["test/report.test.ts"]);
  expect(pick(["README.md"])).toEqual([]);
  expect(pick(["src/other.ts"], { always: ["test/docs.test.ts"] })).toEqual(["test/docs.test.ts", "test/other.test.ts"]);
});

test("lockfiles, configs, migrations and CI select everything", () => {
  for (const f of ["bun.lock", "package.json", "tsconfig.json", "src/db/migrations/0001_x.sql", ".github/workflows/ci.yml"]) {
    expect(affectedTests({ root, changed: [f] }).all).toContain(f);
  }
  expect(affectedTests({ root, changed: [] }).picked.size).toBe(0);
});
