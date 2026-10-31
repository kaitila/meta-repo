// Postgres test databases: create on first use, a lock so two runs never share one,
// a fast reset between tests, and fixture snapshots. Driver-level (postgres.js):
// an app wraps it to hand out its own ORM handle.
import postgres from "postgres";

type Sql = postgres.Sql;

const quiet = { onnotice: () => {} };
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** The same server, connected to its `postgres` database (to create or drop others). */
function adminUrl(url: string): { admin: string; db: string } {
  const u = new URL(url);
  const db = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!db) throw new Error("database URL has no database name");
  u.pathname = "/postgres";
  u.search = "";
  return { admin: u.toString(), db };
}

/** Create the database if it doesn't exist. Returns true if it was created. */
export async function ensureDatabase(url: string): Promise<boolean> {
  const { admin, db } = adminUrl(url);
  const sql = postgres(admin, { max: 1, ...quiet });
  try {
    const [row] = await sql`select 1 as ok from pg_database where datname = ${db}`;
    if (row) return false;
    try {
      await sql.unsafe(`create database ${ident(db)}`);
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === "42P04") return false; // created concurrently
      throw e;
    }
  } finally {
    await sql.end({ timeout: 2 });
  }
}

export async function dropDatabase(url: string): Promise<void> {
  const { admin, db } = adminUrl(url);
  const sql = postgres(admin, { max: 1, ...quiet });
  try {
    await sql.unsafe(`drop database if exists ${ident(db)} with (force)`);
  } finally {
    await sql.end({ timeout: 2 });
  }
}

/**
 * Hold a lock named after the test database for as long as the returned handle lives
 * (normally the whole test process). A second run against the same database waits.
 */
export async function acquireRunLock(url: string, opts: { onWait?: (db: string) => void } = {}) {
  const { admin, db } = adminUrl(url);
  const sql = postgres(admin, { max: 1, idle_timeout: 0, ...quiet });
  const key = `test-kit run: ${db}`;
  const [got] = await sql`select pg_try_advisory_lock(hashtext(${key})) as ok`;
  if (!got?.ok) {
    opts.onWait?.(db);
    await sql`select pg_advisory_lock(hashtext(${key}))`;
  }
  return { release: () => sql.end({ timeout: 2 }) };
}

/** Test databases must look like one: the name ends in `_test` or contains `_test_`. */
export function assertTestDatabase(url: string): void {
  const { db } = adminUrl(url);
  if (!/_test($|_)/.test(db)) {
    throw new Error(`refusing to reset "${db}": a test database's name must end in _test or contain _test_`);
  }
}

export interface TestDbOptions {
  url: string;
  /** Bring the schema up to date (runs once per process, before the first reset). */
  migrate?: (url: string) => Promise<void>;
  /** Schema whose tables are reset (default public). Migration bookkeeping lives elsewhere. */
  schema?: string;
  /** Tables never emptied (e.g. lookup data seeded by migrations). */
  keep?: string[];
}

export interface TestDb {
  sql: Sql;
  /** Empty every table that has rows and restart sequences at 1. */
  fresh(): Promise<void>;
  /**
   * Build a fixture once per process, then restore it from a snapshot on later calls.
   * Call right after fresh(). Returns (a copy of) what build returned.
   */
  cachedFixture<T>(key: string, build: () => Promise<T>): Promise<T>;
  /** Every row of every table as text: for "this secret never reached the database". */
  dumpAllText(): Promise<string>;
  count(table: string): Promise<number>;
  close(): Promise<void>;
}

export function createTestDb(opts: TestDbOptions): TestDb {
  assertTestDatabase(opts.url);
  const schema = opts.schema ?? "public";
  const sql = postgres(opts.url, { max: 4, ...quiet });
  let ready: Promise<{ tables: string[]; sequences: string[]; superuser: boolean }> | undefined;
  const snapshots = new Map<string, { rows: Map<string, { cols: string[]; json: string }>; seqs: [string, number, boolean][]; result: unknown }>();

  const setup = () =>
    (ready ??= (async () => {
      await ensureDatabase(opts.url);
      await opts.migrate?.(opts.url);
      const tables = (await sql`select tablename from pg_tables where schemaname = ${schema} order by tablename`)
        .map((r) => r.tablename as string)
        .filter((t) => !(opts.keep ?? []).includes(t));
      const sequences = (await sql`select format('%I.%I', schemaname, sequencename) as s from pg_sequences where schemaname = ${schema}`).map(
        (r) => r.s as string,
      );
      const [role] = await sql`select rolsuper from pg_roles where rolname = current_user`;
      return { tables, sequences, superuser: Boolean(role?.rolsuper) };
    })());

  const q = (t: string) => `${ident(schema)}.${ident(t)}`;

  async function nonEmpty(tables: string[]): Promise<string[]> {
    if (!tables.length) return [];
    const parts = tables.map((t) => `select '${t.replace(/'/g, "''")}' as t where exists (select 1 from ${q(t)})`);
    return (await sql.unsafe(parts.join(" union all "))).map((r) => r.t as string);
  }

  async function fresh() {
    const { tables, sequences, superuser } = await setup();
    const used = await nonEmpty(tables);
    if (used.length) {
      if (superuser) {
        // Replica mode skips foreign-key triggers, so order doesn't matter and only the
        // dirty tables are touched: far faster than TRUNCATE on many tables.
        // Caution: it skips *all* triggers, user triggers included.
        await sql.begin(async (tx) => {
          await tx.unsafe("set local session_replication_role = replica");
          for (const t of used) await tx.unsafe(`delete from ${q(t)}`);
        });
      } else {
        await sql.unsafe(`truncate ${used.map(q).join(", ")} cascade`);
      }
    }
    if (sequences.length) await sql.unsafe(`select ${sequences.map((s) => `setval('${s.replace(/'/g, "''")}', 1, false)`).join(", ")}`);
  }

  async function cachedFixture<T>(key: string, build: () => Promise<T>): Promise<T> {
    const { tables, sequences, superuser } = await setup();
    const snap = snapshots.get(key);
    if (snap && superuser) {
      await sql.begin(async (tx) => {
        await tx.unsafe("set local session_replication_role = replica");
        for (const [t, { cols, json }] of snap.rows) {
          const list = cols.map(ident).join(", ");
          await tx.unsafe(
            `insert into ${q(t)} (${list}) overriding system value select ${list} from json_populate_recordset(null::${q(t)}, $1::text::json)`,
            [json],
          );
        }
        for (const [s, v, called] of snap.seqs) await tx.unsafe(`select setval($1, $2, $3)`, [s, v, called]);
      });
      return structuredClone(snap.result) as T;
    }
    const result = await build();
    if (!superuser) return result; // can't restore without replica mode: build every time
    const rows = new Map<string, { cols: string[]; json: string }>();
    for (const t of await nonEmpty(tables)) {
      const cols = (
        await sql`select column_name from information_schema.columns
          where table_schema = ${schema} and table_name = ${t} and is_generated = 'NEVER' and generation_expression is null
          order by ordinal_position`
      ).map((r) => r.column_name as string);
      const [r] = await sql.unsafe(`select json_agg(x)::text as j from (select ${cols.map(ident).join(", ")} from ${q(t)}) x`);
      rows.set(t, { cols, json: r!.j as string });
    }
    const seqs: [string, number, boolean][] = [];
    for (const s of sequences) {
      const [r] = await sql.unsafe(`select last_value, is_called from ${s}`);
      seqs.push([s, Number(r!.last_value), Boolean(r!.is_called)]);
    }
    snapshots.set(key, { rows, seqs, result: structuredClone(result) });
    return result;
  }

  return {
    sql,
    fresh,
    cachedFixture,
    async dumpAllText() {
      const { tables } = await setup();
      const out: string[] = [];
      for (const t of tables) {
        for (const r of await sql.unsafe(`select row_to_json(x)::text as j from ${q(t)} x`)) out.push(r.j as string);
      }
      return out.join("\n");
    },
    async count(table) {
      const [r] = await sql.unsafe(`select count(*)::int as n from ${q(table)}`);
      return r!.n as number;
    },
    close: () => sql.end({ timeout: 2 }),
  };
}
