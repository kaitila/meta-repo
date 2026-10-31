import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { requireEnv } from "../config";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

let sql: postgres.Sql | undefined;
let db: Db | undefined;

/** One pool per process, opened on first use. */
export function getDb(): Db {
  if (db) return db;
  const { DATABASE_URL } = requireEnv("DATABASE_URL");
  sql = postgres(DATABASE_URL, { max: 10, onnotice: () => {} });
  return (db = drizzle(sql, { schema }));
}

export async function closeDb(): Promise<void> {
  const s = sql;
  sql = undefined;
  db = undefined;
  await s?.end({ timeout: 5 });
}
