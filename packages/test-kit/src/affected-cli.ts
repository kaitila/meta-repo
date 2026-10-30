#!/usr/bin/env bun
// affected-tests [--base ref] [--explain]: print the tests to run, one per line;
// "all" when everything must run; nothing when nothing changed.
import { parseArgs } from "node:util";
import { affectedTests, changedFiles } from "./affected";

const { values } = parseArgs({ options: { base: { type: "string" }, explain: { type: "boolean" }, root: { type: "string" } } });
const root = values.root ?? process.cwd();
const r = affectedTests({ root, changed: changedFiles(root, values.base) });
if (r.all) {
  if (values.explain) console.error(r.all);
  console.log("all");
} else {
  for (const [t, why] of r.picked) {
    if (values.explain) console.error(`${t}: ${why}`);
    console.log(t);
  }
}
