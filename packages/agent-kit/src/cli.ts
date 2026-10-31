#!/usr/bin/env bun
// agent-kit init [dir]: add the guardrail baseline and templates to a repository.
import { resolve } from "node:path";
import { install, OMIT_FILE } from "./install";

const [cmd, dir = "."] = process.argv.slice(2);
if (cmd !== "init") {
  console.log("Usage: agent-kit init [dir]   add the settings baseline and templates (never overwrites)");
  process.exit(cmd ? 1 : 0);
}
let r;
try {
  r = install(resolve(dir));
} catch (e) {
  console.error(`agent-kit: ${(e as Error).message}`);
  process.exit(1);
}
for (const f of r.created) console.log(`created  ${f}`);
for (const f of r.merged) console.log(`merged   ${f} (permission rules added)`);
for (const f of r.kept) console.log(`kept     ${f} (already there)`);
for (const rule of r.omitted) console.log(`omitted  ${rule} (listed in ${OMIT_FILE})`);
for (const e of r.unmatchedOmit) {
  console.log(`warning  omit entry "${e}" matches no baseline rule or hook command (${OMIT_FILE})`);
}
