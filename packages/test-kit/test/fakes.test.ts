import { afterEach, expect, test } from "bun:test";
import { COMMON_CREDENTIALS, fakeLlm, installFetch, json, on, stripCredentials } from "../src/fakes";

let restore = () => {};
afterEach(() => restore());

test("installFetch answers matched requests, records them, and throws on anything else", async () => {
  const f = installFetch([on("GET", "https://api.example.com/v1/items", () => json([{ id: 1 }]))]);
  restore = f.restore;
  expect(await (await fetch("https://api.example.com/v1/items?page=2")).json()).toEqual([{ id: 1 }]);
  await expect(fetch("https://api.example.com/v1/items", { method: "POST", body: "{}" })).rejects.toThrow(/unexpected request in test: POST/);
  await expect(fetch("https://elsewhere.example.com/")).rejects.toThrow(/unexpected request/);
  expect(f.calls.map((c) => c.method)).toEqual(["GET", "POST", "GET"]);
});

test("restore puts the real fetch back", () => {
  const real = globalThis.fetch;
  installFetch([]).restore();
  expect(globalThis.fetch).toBe(real);
});

test("fakeLlm: first matching rule answers, objects come back as JSON, no match throws", async () => {
  const llm = fakeLlm([
    { match: /summarise/i, reply: "a summary" },
    { match: (r) => r.user.includes("classify"), reply: { label: "spam" } },
  ]);
  expect((await llm.converse("m", { user: "Summarise this" })).text).toBe("a summary");
  expect(JSON.parse((await llm.converse("m", { user: "classify it" })).text)).toEqual({ label: "spam" });
  await expect(llm.converse("m", { user: "something else" })).rejects.toThrow(/no rule matches/);
  expect(llm.calls.length).toBe(3);
});

test("stripCredentials removes real-looking secrets and leaves the rest", () => {
  const env: Record<string, string | undefined> = {
    STRIPE_API_KEY: "x",
    SESSION_SECRET: "x",
    AWS_REGION: "eu-north-1",
    GITHUB_TOKEN: "x",
    DATABASE_URL: "postgres://",
    PROVIDER_CLIENT_ID: "x",
  };
  const gone = stripCredentials([...COMMON_CREDENTIALS, "PROVIDER_*"], env);
  expect(gone.sort()).toEqual(["AWS_REGION", "GITHUB_TOKEN", "PROVIDER_CLIENT_ID", "SESSION_SECRET", "STRIPE_API_KEY"]);
  expect(env.DATABASE_URL).toBe("postgres://");
});
