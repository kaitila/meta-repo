#!/usr/bin/env bun
// docs-check [--json] [--write-index] [--strict-freshness] [--root dir]
// Exit codes: 0 clean (warnings allowed), 1 failures, 2 couldn't run.
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, run } from "./index";

try {
  const { values } = parseArgs({
    options: {
      json: { type: "boolean" },
      "write-index": { type: "boolean" },
      "strict-freshness": { type: "boolean" },
      root: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log("docs-check [--json] [--write-index] [--strict-freshness] [--root dir]");
    process.exit(0);
  }
  const root = resolve(values.root ?? process.cwd());
  const config = await loadConfig(root);
  let result = run(root, config, { strictFreshness: values["strict-freshness"] });
  if (values["write-index"] && result.index) {
    writeFileSync(join(root, result.index.path), result.index.text);
    console.log(`wrote ${result.index.path}`);
    result = run(root, config, { strictFreshness: values["strict-freshness"] });
  }
  const errors = result.failures.filter((f) => f.severity === "error");
  if (values.json) console.log(JSON.stringify(result.failures, null, 2));
  else {
    for (const f of result.failures) console.log(`${f.severity === "warning" ? "warning: " : ""}${f.file}:${f.line}  ${f.kind}  ${f.target}`);
    console.log(`docs-check: ${result.files} files, ${result.decisions.length} decisions, ${errors.length} failures`);
  }
  process.exit(errors.length ? 1 : 0);
} catch (e) {
  console.error(`docs-check: ${(e as Error).message}`);
  process.exit(2);
}
