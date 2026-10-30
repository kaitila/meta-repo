import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { acquireRunLock, assertTestDatabase, createTestDb, dropDatabase, ensureDatabase, type TestDb } from "../src/db";

// A throwaway Postgres. Locally: the container in AGENTS.md; in CI: the job's own.
const BASE = process.env.TEST_KIT_DATABASE_URL ?? "postgres://metarepo:metarepo@127.0.0.1:5544/test_kit_test";
const reachable = await (async () => {
  const u = new URL(BASE);
  u.pathname = "/postgres";
  const sql = postgres(u.toString(), { max: 1, connect_timeout: 2, onnotice: () => {} });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 });
  }
})();
if (!reachable) console.warn(`test-kit: no Postgres at ${new URL(BASE).host}; database tests skipped`);
if (!reachable && process.env.CI) throw new Error("test-kit: CI must provide Postgres (TEST_KIT_DATABASE_URL)");

describe.skipIf(!reachable)("Postgres", () => {
  const url = BASE.replace(/\/[^/]*$/, `/test_kit_test_${process.pid}`);
  let db: TestDb;
  beforeAll(async () => {
    db = createTestDb({
      url,
      migrate: async (u) => {
        const sql = postgres(u, { max: 1, onnotice: () => {} });
        await sql.unsafe(`
          create table if not exists owner (id serial primary key, name text not null);
          create table if not exists item (id serial primary key, owner_id int not null references owner(id), secret text);
          create table if not exists lookup (code text primary key);
          insert into lookup values ('kept') on conflict do nothing;`);
        await sql.end();
      },
      keep: ["lookup"],
    });
  });
  afterAll(async () => {
    await db.close();
    await dropDatabase(url);
  });

  test("fresh empties every used table and restarts sequences; kept tables stay", async () => {
    await db.fresh();
    const [o] = await db.sql`insert into owner (name) values ('a') returning id`;
    await db.sql`insert into item (owner_id) values (${o!.id})`;
    await db.fresh();
    expect(await db.count("owner")).toBe(0);
    expect(await db.count("item")).toBe(0);
    expect(await db.count("lookup")).toBe(1);
    const [again] = await db.sql`insert into owner (name) values ('b') returning id`;
    expect(again!.id).toBe(1);
  });

  test("cachedFixture builds once, then restores rows, sequences and the returned value", async () => {
    let builds = 0;
    const build = async () => {
      builds++;
      const [o] = await db.sql`insert into owner (name) values ('fixture') returning id`;
      await db.sql`insert into item (owner_id, secret) values (${o!.id}, 's1'), (${o!.id}, 's2')`;
      return { ownerId: o!.id as number };
    };
    await db.fresh();
    const first = await db.cachedFixture("two-items", build);
    await db.fresh();
    const second = await db.cachedFixture("two-items", build);
    expect(builds).toBe(1);
    expect(second).toEqual(first);
    expect(await db.count("item")).toBe(2);
    const [next] = await db.sql`insert into owner (name) values ('after') returning id`;
    expect(next!.id).toBe(first.ownerId + 1); // the sequence came back too
  });

  test("dumpAllText shows what reached the database", async () => {
    await db.fresh();
    await db.sql`insert into owner (name) values ('visible')`;
    const all = await db.dumpAllText();
    expect(all).toContain("visible");
    expect(all).not.toContain("never-stored");
  });

  test("the run lock makes a second run wait until the first lets go", async () => {
    const first = await acquireRunLock(url);
    let waited = false;
    let got = false;
    const second = acquireRunLock(url, { onWait: () => (waited = true) }).then((l) => {
      got = true;
      return l;
    });
    await Bun.sleep(300);
    expect(waited).toBe(true);
    expect(got).toBe(false);
    await first.release();
    await (await second).release();
    expect(got).toBe(true);
  });

  test("ensureDatabase is idempotent", async () => {
    expect(await ensureDatabase(url)).toBe(false);
  });
});

test("only databases named like test databases can be reset", () => {
  expect(() => assertTestDatabase("postgres://u@h/app")).toThrow(/refusing/);
  expect(() => assertTestDatabase("postgres://u@h/app_prod")).toThrow(/refusing/);
  expect(() => assertTestDatabase("postgres://u@h/app_test")).not.toThrow();
  expect(() => assertTestDatabase("postgres://u@h/app_test_slot_w1")).not.toThrow();
});
