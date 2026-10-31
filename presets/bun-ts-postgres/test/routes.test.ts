import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { resetEnv } from "../src/config";
import { closeDb } from "../src/db/client";
import { call, dbReachable, testDb } from "./helpers";

describe("without a database", () => {
  test("an unknown path is a 404, a known path with the wrong method a 405", async () => {
    const r404 = await call("GET", "/api/nope");
    expect(r404.status).toBe(404);
    expect(await r404.json()).toEqual({ error: "not found" });
    const r405 = await call("DELETE", "/api/items");
    expect(r405.status).toBe(405);
    expect(r405.headers.get("allow")).toBe("GET, POST");
  });

  test("a POST without the x-app header, or from another origin, is refused before the handler runs", async () => {
    const noHeader = await call("POST", "/api/items", { json: { name: "x" }, headers: { "x-app": "" } });
    expect(noHeader.status).toBe(403);
    const otherOrigin = await call("POST", "/api/items", { json: { name: "x" }, headers: { origin: "https://evil.example" } });
    expect(otherOrigin.status).toBe(403);
    expect(await otherOrigin.json()).toEqual({ error: "cross-origin request refused" });
  });

  test("validation failures name the field", async () => {
    const r = await call("POST", "/api/items", { json: { name: "" } });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toStartWith("name: ");
    const extra = await call("POST", "/api/items", { json: { name: "a", admin: true } });
    expect(extra.status).toBe(400);
    const notJson = await call("POST", "/api/items", { headers: { "content-type": "text/plain" } });
    expect(notJson.status).toBe(415);
  });

  test("security headers are on every response, no-store on the API", async () => {
    const r = await call("GET", "/api/nope");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  test("/healthz is a 503 when the database is down, and says nothing about why", async () => {
    const saved = process.env.DATABASE_URL;
    await closeDb();
    process.env.DATABASE_URL = "postgres://nobody:hunter2@127.0.0.1:1/none_test";
    resetEnv();
    try {
      const r = await call("GET", "/healthz");
      expect(r.status).toBe(503);
      const text = await r.text();
      expect(text).toBe(JSON.stringify({ ok: false }));
    } finally {
      await closeDb();
      process.env.DATABASE_URL = saved;
      resetEnv();
    }
  });
});

describe.skipIf(!dbReachable)("with a database", () => {
  beforeEach(() => testDb().fresh());
  afterAll(async () => {
    await closeDb();
    await testDb().close();
  });

  test("POST creates an item and GET lists it", async () => {
    const created = await call("POST", "/api/items", { json: { name: "  first  " }, headers: { origin: "http://localhost:3000" } });
    expect(created.status).toBe(201);
    const { item } = await created.json();
    expect(item.name).toBe("first");
    expect(item.id).toMatch(/^[0-9a-f-]{36}$/);
    const list = await call("GET", "/api/items");
    expect(list.status).toBe(200);
    expect((await list.json()).items.map((i: { id: string }) => i.id)).toEqual([item.id]);
    expect(await testDb().count("items")).toBe(1);
  });

  test("a refused POST writes nothing", async () => {
    await call("POST", "/api/items", { json: { name: "x" }, headers: { "x-app": "" } });
    await call("POST", "/api/items", { json: { name: "" } });
    expect(await testDb().count("items")).toBe(0);
  });

  test("/healthz answers ok with the version", async () => {
    const r = await call("GET", "/healthz");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, version: "test" });
  });
});
