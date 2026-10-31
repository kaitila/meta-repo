import { defineConfig } from "drizzle-kit";

// `bun run db:generate` writes a new migration from src/db/schema.ts. It diffs the
// schema against the committed snapshots, so it needs no database.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
});
