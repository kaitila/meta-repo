import { describe, expect, test } from "bun:test";
import { type Actor, Foreman, ForemanError } from "../src/core";
import { toMarkdown } from "../src/export";
import { openDb } from "../src/store";

const human: Actor = { name: "ada", kind: "human" };
const worker: Actor = { name: "worker-1", kind: "agent" };
const verifier: Actor = { name: "verifier-1", kind: "agent" };

function setup() {
  let clock = 1_000_000;
  const f = new Foreman(openDb(":memory:"), null, () => clock);
  return { f, tick: (ms: number) => (clock += ms) };
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ForemanError) return e.code;
    throw e;
  }
  return "no error";
}

const task = (f: Foreman, extra: Partial<Parameters<Foreman["create"]>[0]> = {}) =>
  f.create(
    { title: "Add a stage filter", acceptance: ["cmd: bun test", "statement: the filter is in the UI"], ready: false, ...extra },
    human,
  );

describe("lifecycle", () => {
  test("auto: claim → progress → submit → verify → approved → merged", () => {
    const { f } = setup();
    const t = task(f, { risk: "auto" });
    expect(t.id).toBe("T-0001");
    expect(t.acceptance.map((c) => c.kind)).toEqual(["cmd", "statement"]);
    f.markReady(t.id, human);
    expect(f.claim(null, worker).assignee).toBe("worker-1");
    f.progress(t.id, worker, { branch: "t-0001", note: "started" });
    expect(f.submit(t.id, worker, { pr: "#12" }).status).toBe("in_review");
    f.startVerify(t.id, verifier);
    const v = f.recordVerify(t.id, verifier, [
      { check: "c1", pass: true, evidence: "bun test: 40 pass" },
      { check: "c2", pass: true, evidence: "saw it on /investors" },
    ]);
    expect(v.status).toBe("approved");
    expect(f.merged(t.id, worker).status).toBe("done");
    expect(f.events(t.id).map((e) => e.type)).toEqual([
      "created", "ready", "claimed", "progress", "submitted", "verify_started", "verified", "merged",
    ]);
  });

  test("review: a verified task waits for a person", () => {
    const { f } = setup();
    const t = task(f, { risk: "review", ready: true });
    f.claim(t.id, worker);
    f.submit(t.id, worker, { pr: "#1" });
    f.startVerify(t.id, verifier);
    const v = f.recordVerify(t.id, verifier, [
      { check: "c1", pass: true, evidence: "ok" },
      { check: "c2", pass: true, evidence: "ok" },
    ]);
    expect(v.status).toBe("needs_approval");
    expect(code(() => f.approve(t.id, verifier))).toBe("human_only");
    expect(code(() => f.merged(t.id, worker))).toBe("bad_status");
    expect(f.approve(t.id, human).status).toBe("approved");
  });

  test("a failed check sends the task back to ready, with the results kept", () => {
    const { f } = setup();
    const t = task(f, { ready: true });
    f.claim(t.id, worker);
    f.submit(t.id, worker, { pr: "#1" });
    f.startVerify(t.id, verifier);
    const v = f.recordVerify(t.id, verifier, [
      { check: "c1", pass: false, evidence: "2 tests fail" },
      { check: "c2", pass: true, evidence: "ok" },
    ]);
    expect(v.status).toBe("ready");
    expect(v.assignee).toBeNull();
    expect(toMarkdown(v, f.events(t.id))).toContain("FAIL: 2 tests fail");
  });
});

describe("guards", () => {
  test("ready needs an acceptance check, also when created ready", () => {
    const { f } = setup();
    const t = f.create({ title: "vague" }, human);
    expect(code(() => f.markReady(t.id, human))).toBe("invalid");
    expect(code(() => f.create({ title: "vague", ready: true }, human))).toBe("invalid");
    expect(f.list().length).toBe(1); // the refused create left nothing behind
  });

  test("a worker can't verify its own task", () => {
    const { f } = setup();
    const t = task(f, { ready: true });
    f.claim(t.id, worker);
    f.submit(t.id, worker, { pr: "#1" });
    expect(code(() => f.startVerify(t.id, worker))).toBe("own_work");
  });

  test("a verdict must cover every check, and only real ones", () => {
    const { f } = setup();
    const t = task(f, { ready: true });
    f.claim(t.id, worker);
    f.submit(t.id, worker, { pr: "#1" });
    f.startVerify(t.id, verifier);
    expect(code(() => f.recordVerify(t.id, verifier, [{ check: "c1", pass: true, evidence: "" }]))).toBe("incomplete");
    expect(
      code(() =>
        f.recordVerify(t.id, verifier, [
          { check: "c1", pass: true, evidence: "" },
          { check: "c2", pass: true, evidence: "" },
          { check: "c9", pass: true, evidence: "" },
        ]),
      ),
    ).toBe("invalid");
  });

  test("only the holder can act on a claim", () => {
    const { f } = setup();
    const t = task(f, { ready: true });
    f.claim(t.id, worker);
    expect(code(() => f.claim(t.id, verifier))).toBe("bad_status");
    expect(code(() => f.progress(t.id, verifier))).toBe("not_holder");
    expect(code(() => f.submit(t.id, verifier, { pr: "#1" }))).toBe("not_holder");
  });

  test("risk human: agents can't claim it, a person can and signs it off", () => {
    const { f } = setup();
    const t = f.create({ title: "Rotate prod keys", risk: "human", ready: true }, human);
    expect(f.ready("agent")).toEqual([]);
    expect(code(() => f.claim(t.id, worker))).toBe("human_only");
    f.claim(t.id, human);
    expect(f.approve(t.id, human).status).toBe("approved");
  });

  test("blockers: not claimable until they are done; unknown blockers are refused at create", () => {
    const { f } = setup();
    const a = task(f, { ready: true, risk: "auto" });
    const b = task(f, { ready: true, blockedBy: [a.id] });
    expect(f.ready().map((t) => t.id)).toEqual([a.id]);
    expect(code(() => f.claim(b.id, worker))).toBe("blocked");
    expect(code(() => task(f, { blockedBy: ["T-9999"] }))).toBe("not_found");
  });

  test("events can't be edited or deleted", () => {
    const { f } = setup();
    task(f);
    expect(() => f.db.exec("UPDATE events SET type = 'x'")).toThrow(/append-only/);
    expect(() => f.db.exec("DELETE FROM events")).toThrow(/append-only/);
  });
});

describe("leases", () => {
  test("an expired claim goes back to ready and someone else can take it", () => {
    const { f, tick } = setup();
    const t = task(f, { ready: true });
    f.claim(t.id, worker, 10);
    tick(11 * 60_000);
    const other: Actor = { name: "worker-2", kind: "agent" };
    expect(f.claim(null, other).assignee).toBe("worker-2");
    expect(f.events(t.id).some((e) => e.type === "lease_expired")).toBe(true);
  });

  test("heartbeat keeps a claim alive", () => {
    const { f, tick } = setup();
    const t = task(f, { ready: true });
    f.claim(t.id, worker, 10);
    tick(8 * 60_000);
    f.heartbeat(t.id, worker, 10);
    tick(8 * 60_000);
    expect(f.reclaim(human)).toEqual([]);
    expect(f.get(t.id).assignee).toBe("worker-1");
  });

  test("an expired verification goes back to in_review", () => {
    const { f, tick } = setup();
    const t = task(f, { ready: true });
    f.claim(t.id, worker);
    f.submit(t.id, worker, { pr: "#1" });
    f.startVerify(t.id, verifier, 5);
    tick(6 * 60_000);
    expect(f.reclaim(human)).toEqual([t.id]);
    expect(f.get(t.id).status).toBe("in_review");
  });
});

test("reserve hands out each number once", () => {
  const { f } = setup();
  expect([f.reserve("migration", worker), f.reserve("migration", verifier), f.reserve("decision", worker)]).toEqual([1, 2, 1]);
});
