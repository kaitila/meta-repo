#!/usr/bin/env bun
// meta-repo create | init | sync: start a project, add the kit to a repo, take the kit's updates.
import { parseArgs } from "node:util";
import { create, DEFAULT_PRESET, init, presets } from "./create";
import type { Change } from "./kit";
import { sync } from "./sync";

const USAGE = `Usage:
  create <dir> [--preset ${DEFAULT_PRESET}] [--name n] [--no-install] [--no-git]
                     a new project from a preset, with the kit, foreman.json, CI and a first commit
  init [dir] [--name n]
                     add the kit to an existing repository; never overwrites a file
  sync [dir] [--dry-run]
                     update the kit's files to this meta-repo version; keeps every file the project changed`;

const show = (changes: Change[]) => {
  for (const c of changes) console.log(`${c.action.padEnd(8)} ${c.path}${c.note ? ` (${c.note})` : ""}`);
};

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      preset: { type: "string" },
      name: { type: "string" },
      "no-install": { type: "boolean" },
      "no-git": { type: "boolean" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, dir, ...rest] = positionals;
  if (values.help || !cmd) {
    console.log(`${USAGE}\nPresets: ${presets().join(", ")}`);
    process.exit(values.help ? 0 : 2);
  }
  if (rest.length) throw new Error(`unexpected argument: ${rest[0]}`);
  if (cmd === "create") {
    if (!dir) throw new Error("create needs a directory");
    show(create(dir, { preset: values.preset, name: values.name, install: !values["no-install"], git: !values["no-git"] }));
    console.log(`\nNext: cd ${dir} && bun run check`);
  } else if (cmd === "init") {
    show(init(dir ?? ".", { name: values.name }));
    console.log("\nNext: fill in AGENTS.md's Commands, review the changes and commit them.");
  } else if (cmd === "sync") {
    const r = sync(dir ?? ".", { dryRun: values["dry-run"] });
    console.log(`kit ${r.from} -> ${r.to}${values["dry-run"] ? " (dry run: nothing written)" : ""}`);
    if (r.changes.length) show(r.changes);
    else console.log("up to date");
    if (r.reinstall) console.log("\nVendored packages changed: run bun install.");
    if (!values["dry-run"] && r.changes.some((c) => c.action === "updated" || c.action === "created" || c.action === "merged")) {
      console.log("Nothing was committed: review with git diff.");
    }
  } else throw new Error(`unknown command "${cmd}"\n${USAGE}`);
} catch (e) {
  console.error(`meta-repo: ${(e as Error).message}`);
  process.exit(1);
}
