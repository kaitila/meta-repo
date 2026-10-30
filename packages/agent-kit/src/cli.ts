#!/usr/bin/env bun
// agent-kit init [dir]: add the guardrail baseline and templates to a repository.
import { resolve } from "node:path";
import { install } from "./install";

const [cmd, dir = "."] = process.argv.slice(2);
if (cmd !== "init") {
  console.log("Usage: agent-kit init [dir]   add the settings baseline and templates (never overwrites)");
  process.exit(cmd ? 1 : 0);
}
const r = install(resolve(dir));
for (const f of r.created) console.log(`created  ${f}`);
for (const f of r.merged) console.log(`merged   ${f} (permission rules added)`);
for (const f of r.kept) console.log(`kept     ${f} (already there)`);
