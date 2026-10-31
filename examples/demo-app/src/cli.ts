#!/usr/bin/env bun
// demo-app CLI: serve | db:migrate | help. Errors are one line, without a stack.
import { parseArgs } from "node:util";
import { requireEnv } from "./config";
import { closeDb } from "./db/client";
import { runMigrations } from "./db/migrate";
import { SafeError } from "./lib/errors";
import { startServer } from "./server";

const HELP = `usage: bun src/cli.ts <command>
  serve [--host 127.0.0.1] [--port n]   start the HTTP server
  db:migrate                            apply the committed migrations
  help                                  show this`;

async function main(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { host: { type: "string" }, port: { type: "string" } },
  });
  const [cmd = "help"] = positionals;
  switch (cmd) {
    case "serve": {
      const port = values.port === undefined ? undefined : Number(values.port);
      if (port !== undefined && !Number.isInteger(port)) throw new Error("--port must be a number");
      const server = startServer({ port, host: values.host });
      console.log(`listening on http://${server.hostname}:${server.port}`);
      const stop = async () => {
        await server.stop();
        await closeDb();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    case "db:migrate": {
      await runMigrations(requireEnv("DATABASE_URL").DATABASE_URL);
      console.log("migrations applied");
      return;
    }
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      throw new Error(`unknown command "${cmd}" (try: help)`);
  }
}

/** Our own errors carry safe text; a driver's could hold a connection string or a row. */
export function cliMessage(e: unknown): string {
  const codeOf = (x: unknown) => (typeof (x as { code?: unknown })?.code === "string" ? (x as { code: string }).code : undefined);
  const code = codeOf(e);
  if (e instanceof SafeError || (e instanceof Error && e.constructor === Error && (!code || code.startsWith("ERR_PARSE_ARGS")))) return e.message;
  // Only the error's class and code (e.g. ECONNREFUSED, or a Postgres SQLSTATE) are shown.
  const kind = e instanceof Error ? e.constructor.name : typeof e;
  return `failed (${[kind, code ?? codeOf((e as { cause?: unknown })?.cause)].filter(Boolean).join(" ")})`;
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(`error: ${cliMessage(e)}`);
    process.exit(1);
  });
}
