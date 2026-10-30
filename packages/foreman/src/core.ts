// Foreman's core: tasks, claims with leases, verification and sign-off (D0002).
// The CLI and the MCP server are thin layers over this; nothing here knows
// which agent tool is calling (D0005).
import type { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { gitPolicy, isProtected, mayTouchProtected, type Policy } from "./policy";
import { dbPath, openDb, repoRoot } from "./store";

export type Risk = "auto" | "review" | "human";
export type Status =
  | "draft" // written, not yet ready to work on
  | "ready" // can be claimed once its blockers are done
  | "claimed" // a worker holds it, not started
  | "in_progress"
  | "in_review" // PR submitted, waiting for a verifier
  | "verifying" // a verifier holds it
  | "needs_approval" // verified; risk "review" waits for a human
  | "approved" // cleared to merge
  | "done" // merged
  | "cancelled";

export interface Check {
  id: string; // c1, c2, ...
  kind: "cmd" | "statement"; // a command that must exit 0, or a claim the verifier judges
  text: string;
}

export interface Task {
  id: string;
  title: string;
  spec: string;
  acceptance: Check[];
  paths: string[];
  risk: Risk;
  status: Status;
  parent: string | null;
  blockedBy: string[];
  discoveredFrom: string | null;
  assignee: string | null;
  leaseUntil: number | null;
  branch: string | null;
  worktree: string | null;
  pr: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface Event {
  id: number;
  taskId: string | null;
  at: number;
  actor: string;
  actorKind: Actor["kind"];
  type: string;
  data: Record<string, unknown>;
}

export interface Actor {
  name: string;
  kind: "human" | "agent";
}

export interface CheckResult {
  check: string; // Check.id
  pass: boolean;
  evidence: string; // what the verifier ran or read, and what it saw
}

export class ForemanError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const DEFAULT_LEASE_MINUTES = 30;

/**
 * Who is calling. FOREMAN_ACTOR names them. A command Claude Code runs for the model
 * (CLAUDE_CODE_CHILD_SESSION=1), or anything with FOREMAN_AGENT=1, is an agent.
 * Not CLAUDECODE=1: Claude Code also sets that in IDE terminals, where a person types.
 * This is a guardrail, not a boundary: the hard limits live outside the agent (D0003).
 */
export function actorFromEnv(env = process.env): Actor {
  const agent = env.CLAUDE_CODE_CHILD_SESSION === "1" || env.FOREMAN_AGENT === "1";
  const name = env.FOREMAN_ACTOR || (agent ? `agent-${process.pid}` : env.USER || "human");
  return { name, kind: agent ? "agent" : "human" };
}

type Row = Record<string, unknown>;

function toTask(r: Row): Task {
  return {
    id: r.id as string,
    title: r.title as string,
    spec: r.spec as string,
    acceptance: JSON.parse(r.acceptance as string),
    paths: JSON.parse(r.paths as string),
    risk: r.risk as Risk,
    status: r.status as Status,
    parent: (r.parent as string) ?? null,
    blockedBy: JSON.parse(r.blocked_by as string),
    discoveredFrom: (r.discovered_from as string) ?? null,
    assignee: (r.assignee as string) ?? null,
    leaseUntil: (r.lease_until as number) ?? null,
    branch: (r.branch as string) ?? null,
    worktree: (r.worktree as string) ?? null,
    pr: (r.pr as string) ?? null,
    createdBy: r.created_by as string,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function toEvent(r: Row): Event {
  return {
    id: r.id as number,
    taskId: (r.task_id as string) ?? null,
    at: r.at as number,
    actor: r.actor as string,
    actorKind: r.actor_kind as Actor["kind"],
    type: r.type as string,
    data: JSON.parse(r.data as string),
  };
}

export interface CreateInput {
  title: string;
  spec?: string;
  acceptance?: (string | Omit<Check, "id">)[]; // "cmd: bun test" / "statement: ..." / plain text = statement
  paths?: string[];
  risk?: Risk;
  parent?: string;
  blockedBy?: string[];
  discoveredFrom?: string;
  ready?: boolean;
}

export function parseCheck(c: string | Omit<Check, "id">, i: number): Check {
  if (typeof c !== "string") return { id: `c${i + 1}`, kind: c.kind, text: c.text.trim() };
  const m = /^(cmd|statement)\s*:\s*(.+)$/s.exec(c.trim());
  if (m) return { id: `c${i + 1}`, kind: m[1] as Check["kind"], text: m[2]!.trim() };
  return { id: `c${i + 1}`, kind: "statement", text: c.trim() };
}

export class Foreman {
  constructor(
    public db: Database,
    public root: string | null = null, // repo root, for reserving numbers from files
    private now: () => number = Date.now,
    public policy: Policy = gitPolicy(root),
  ) {}

  static open(cwd = process.cwd()): Foreman {
    const root = repoRoot(cwd);
    return new Foreman(openDb(dbPath(cwd)), root, Date.now, gitPolicy(root));
  }

  /** Default risk for a new task: "review" if its declared paths may touch protected ones (D0008). */
  defaultRisk(paths: string[]): Risk {
    return mayTouchProtected(paths, this.policy.protectedPaths) ? "review" : "auto";
  }

  // ---- reading ----

  get(id: string): Task {
    const r = this.db.query(`SELECT * FROM tasks WHERE id = ?`).get(id) as Row | null;
    if (!r) throw new ForemanError("not_found", `no task ${id}`);
    return toTask(r);
  }

  list(filter: { status?: Status[]; assignee?: string } = {}): Task[] {
    let sql = `SELECT * FROM tasks`;
    const where: string[] = [];
    const params: string[] = [];
    if (filter.status?.length) {
      where.push(`status IN (${filter.status.map(() => "?").join(",")})`);
      params.push(...filter.status);
    }
    if (filter.assignee) {
      where.push(`assignee = ?`);
      params.push(filter.assignee);
    }
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    sql += ` ORDER BY num`;
    return (this.db.query(sql).all(...params) as Row[]).map(toTask);
  }

  events(taskId?: string): Event[] {
    const rows = taskId
      ? this.db.query(`SELECT * FROM events WHERE task_id = ? ORDER BY id`).all(taskId)
      : this.db.query(`SELECT * FROM events ORDER BY id`).all();
    return (rows as Row[]).map(toEvent);
  }

  /** Ready tasks whose blockers are all done. Unknown blockers count as not done (fail closed). */
  ready(forKind: Actor["kind"] = "agent"): Task[] {
    const done = new Set(this.list({ status: ["done"] }).map((t) => t.id));
    return this.list({ status: ["ready"] }).filter(
      (t) => t.blockedBy.every((b) => done.has(b)) && (forKind === "human" || t.risk !== "human"),
    );
  }

  // ---- writing (every write is one IMMEDIATE transaction plus an event) ----

  private tx<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  private event(taskId: string | null, actor: Actor, type: string, data: object = {}) {
    this.db
      .query(
        `INSERT INTO events (task_id, at, actor, actor_kind, type, data) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(taskId, this.now(), actor.name, actor.kind, type, JSON.stringify(data));
  }

  private set(id: string, fields: Record<string, string | number | null>) {
    const keys = Object.keys(fields);
    this.db
      .query(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => fields[k]!), this.now(), id);
  }

  private expect(t: Task, allowed: Status[], verb: string) {
    if (!allowed.includes(t.status)) {
      throw new ForemanError(
        "bad_status",
        `can't ${verb} ${t.id}: it is ${t.status} (needs ${allowed.join(" or ")})`,
      );
    }
  }

  private holder(t: Task, actor: Actor, verb: string) {
    if (t.assignee !== actor.name) {
      throw new ForemanError(
        "not_holder",
        `can't ${verb} ${t.id}: it is held by ${t.assignee ?? "nobody"}, not ${actor.name}`,
      );
    }
  }

  create(input: CreateInput, actor: Actor): Task {
    if (!input.title.trim()) throw new ForemanError("invalid", "a task needs a title");
    const risk = input.risk ?? this.defaultRisk(input.paths ?? []);
    return this.tx(() => {
      for (const ref of [input.parent, input.discoveredFrom, ...(input.blockedBy ?? [])]) {
        if (ref) this.get(ref);
      }
      const { n } = this.db.query(`SELECT COALESCE(MAX(num), 0) + 1 AS n FROM tasks`).get() as {
        n: number;
      };
      const id = `T-${String(n).padStart(4, "0")}`;
      const at = this.now();
      const acceptance = (input.acceptance ?? []).map(parseCheck);
      this.db
        .query(
          `INSERT INTO tasks (id, num, title, spec, acceptance, paths, risk, status, parent,
             blocked_by, discovered_from, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          n,
          input.title.trim(),
          input.spec ?? "",
          JSON.stringify(acceptance),
          JSON.stringify(input.paths ?? []),
          risk,
          "draft",
          input.parent ?? null,
          JSON.stringify(input.blockedBy ?? []),
          input.discoveredFrom ?? null,
          actor.name,
          at,
          at,
        );
      this.event(id, actor, "created", { title: input.title, risk, riskFrom: input.risk ? "given" : "paths" });
      // "ready" goes through the same rules as markReady (it needs a check).
      return input.ready ? this.markReady(id, actor) : this.get(id);
    });
  }

  /** draft → ready. A task an agent may work on needs at least one acceptance check. */
  markReady(id: string, actor: Actor): Task {
    return this.tx(() => {
      const t = this.get(id);
      this.expect(t, ["draft"], "mark ready");
      if (t.risk !== "human" && t.acceptance.length === 0) {
        throw new ForemanError("invalid", `${id} has no acceptance checks; add one before it is ready`);
      }
      this.set(id, { status: "ready" });
      this.event(id, actor, "ready");
      return this.get(id);
    });
  }

  /**
   * Claim a task (or the next ready one). Atomic: two callers can never both win.
   * Expired leases are released first, so a dead worker's task comes back.
   */
  claim(id: string | null, actor: Actor, leaseMinutes = DEFAULT_LEASE_MINUTES): Task {
    return this.tx(() => {
      this.releaseExpired(actor);
      const t = id ? this.get(id) : this.ready(actor.kind)[0];
      if (!t) throw new ForemanError("none_ready", "no ready task to claim");
      this.expect(t, ["ready"], "claim");
      if (t.risk === "human" && actor.kind !== "human") {
        throw new ForemanError("human_only", `${t.id} is risk "human": a person does it, not an agent`);
      }
      if (!this.ready("human").some((r) => r.id === t.id)) {
        throw new ForemanError("blocked", `${t.id} is waiting on ${t.blockedBy.join(", ")}`);
      }
      this.set(t.id, {
        status: "claimed",
        assignee: actor.name,
        lease_until: this.now() + leaseMinutes * 60_000,
      });
      this.event(t.id, actor, "claimed", { leaseMinutes });
      return this.get(t.id);
    });
  }

  /** Keep a claim alive. Workers call this (or progress) more often than the lease length. */
  heartbeat(id: string, actor: Actor, leaseMinutes = DEFAULT_LEASE_MINUTES): Task {
    return this.tx(() => {
      const t = this.get(id);
      this.expect(t, ["claimed", "in_progress", "verifying"], "heartbeat");
      this.holder(t, actor, "heartbeat");
      this.set(id, { lease_until: this.now() + leaseMinutes * 60_000 });
      return this.get(id);
    });
  }

  progress(
    id: string,
    actor: Actor,
    p: { note?: string; branch?: string; worktree?: string } = {},
  ): Task {
    return this.tx(() => {
      const t = this.get(id);
      this.expect(t, ["claimed", "in_progress"], "report progress on");
      this.holder(t, actor, "report progress on");
      const fields: Record<string, string | number | null> = {
        status: "in_progress",
        lease_until: this.now() + DEFAULT_LEASE_MINUTES * 60_000,
      };
      if (p.branch) fields.branch = p.branch;
      if (p.worktree) fields.worktree = p.worktree;
      this.set(id, fields);
      this.event(id, actor, "progress", p);
      return this.get(id);
    });
  }

  /** The worker hands in its PR. It lets go of the task: verification is someone else's job. */
  submit(id: string, actor: Actor, s: { pr: string; summary?: string }): Task {
    return this.tx(() => {
      const t = this.get(id);
      this.expect(t, ["claimed", "in_progress"], "submit");
      this.holder(t, actor, "submit");
      if (!s.pr.trim()) throw new ForemanError("invalid", "submit needs the PR (url or number)");
      this.set(id, { status: "in_review", pr: s.pr.trim(), assignee: null, lease_until: null });
      this.event(id, actor, "submitted", s);
      return this.get(id);
    });
  }

  /** Everyone who has worked on the task. None of them may verify it. */
  workers(id: string): Set<string> {
    const rows = this.db
      .query(`SELECT DISTINCT actor FROM events WHERE task_id = ? AND type IN ('claimed','progress','submitted')`)
      .all(id) as { actor: string }[];
    return new Set(rows.map((r) => r.actor));
  }

  startVerify(id: string, actor: Actor, leaseMinutes = DEFAULT_LEASE_MINUTES): Task {
    return this.tx(() => {
      this.releaseExpired(actor);
      const t = this.get(id);
      this.expect(t, ["in_review"], "verify");
      if (this.workers(id).has(actor.name)) {
        throw new ForemanError("own_work", `${actor.name} worked on ${id} and can't verify it`);
      }
      this.set(id, {
        status: "verifying",
        assignee: actor.name,
        lease_until: this.now() + leaseMinutes * 60_000,
      });
      this.event(id, actor, "verify_started");
      return this.get(id);
    });
  }

  /**
   * The verifier's verdict, one result per acceptance check. All pass: "auto" tasks
   * are approved to merge, "review" tasks wait for a person. Any fail: back to ready
   * with the results, so the next worker sees what's missing.
   */
  recordVerify(id: string, actor: Actor, results: CheckResult[]): Task {
    // Outside the transaction: it runs git. The branch can't change under us in a way
    // that matters, because escalation only ever adds a person.
    const before = this.get(id);
    const branch = before.branch;
    const changed = before.risk === "auto" ? this.policy.changedFiles({ branch, pr: before.pr }) : [];
    return this.tx(() => {
      const t = this.get(id);
      this.expect(t, ["verifying"], "record a verdict on");
      this.holder(t, actor, "record a verdict on");
      const byCheck = new Map(results.map((r) => [r.check, r]));
      const missing = t.acceptance.filter((c) => !byCheck.has(c.id)).map((c) => c.id);
      if (missing.length) {
        throw new ForemanError("incomplete", `no result for ${missing.join(", ")}: every check needs one`);
      }
      const unknown = results.filter((r) => !t.acceptance.some((c) => c.id === r.check));
      if (unknown.length) {
        throw new ForemanError("invalid", `unknown checks: ${unknown.map((r) => r.check).join(", ")}`);
      }
      const pass = results.every((r) => r.pass);
      let next: Status = !pass ? "ready" : t.risk === "auto" ? "approved" : "needs_approval";
      this.set(id, { status: next, assignee: null, lease_until: null });
      this.event(id, actor, pass ? "verified" : "verify_failed", { results });
      if (next === "approved") {
        // The real diff decides (D0008): a protected file, or a diff we can't see, needs a person.
        // An empty diff is as good as none: nothing to approve automatically.
        const seen = changed && changed.length ? changed : null;
        const hit = seen === null ? null : seen.filter((f) => isProtected(f, this.policy.protectedPaths));
        if (hit === null || hit.length) {
          next = "needs_approval";
          this.set(id, { status: next });
          this.event(id, actor, "escalated", hit === null ? { reason: "couldn't see the PR's changes (none found)", branch, pr: before.pr } : { reason: "changes protected paths", files: hit });
        }
      }
      return this.get(id);
    });
  }

  /** A person signs off a verified "review" task (or any "human" task they finished). */
  approve(id: string, actor: Actor, note?: string): Task {
    return this.tx(() => {
      const t = this.get(id);
      if (actor.kind !== "human") {
        throw new ForemanError("human_only", `only a person can approve ${id}`);
      }
      this.expect(t, t.risk === "human" ? ["claimed", "in_progress", "in_review", "needs_approval"] : ["needs_approval"], "approve");
      this.set(id, { status: "approved", assignee: null, lease_until: null });
      this.event(id, actor, "approved", { note });
      return this.get(id);
    });
  }

  /** The approved PR was merged. */
  merged(id: string, actor: Actor, pr?: string): Task {
    return this.tx(() => {
      const t = this.get(id);
      this.expect(t, ["approved"], "mark merged");
      this.set(id, { status: "done", ...(pr ? { pr } : {}) });
      this.event(id, actor, "merged", { pr: pr ?? t.pr });
      return this.get(id);
    });
  }

  cancel(id: string, actor: Actor, reason: string): Task {
    return this.tx(() => {
      const t = this.get(id);
      if (t.status === "done") throw new ForemanError("bad_status", `${id} is already done`);
      this.set(id, { status: "cancelled", assignee: null, lease_until: null });
      this.event(id, actor, "cancelled", { reason });
      return this.get(id);
    });
  }

  /** Release claims whose lease ran out: the worker or verifier is gone. Returns the ids. */
  releaseExpired(actor: Actor): string[] {
    const stale = this.db
      .query(
        `SELECT * FROM tasks WHERE lease_until IS NOT NULL AND lease_until < ?
           AND status IN ('claimed','in_progress','verifying')`,
      )
      .all(this.now()) as Row[];
    for (const r of stale.map(toTask)) {
      const back: Status = r.status === "verifying" ? "in_review" : "ready";
      this.set(r.id, { status: back, assignee: null, lease_until: null });
      this.event(r.id, actor, "lease_expired", { was: r.assignee, status: r.status });
    }
    return stale.map((r) => r.id as string);
  }

  reclaim(actor: Actor): string[] {
    return this.tx(() => this.releaseExpired(actor));
  }

  /**
   * Hand out the next number for something parallel PRs would otherwise clash on.
   * "decision" looks at docs/decisions/Dnnnn-*.md on disk as well as earlier reservations.
   */
  reserve(kind: string, actor: Actor, taskId?: string): number {
    return this.tx(() => {
      if (taskId) this.get(taskId);
      let onDisk = 0;
      if (kind === "decision" && this.root) {
        try {
          for (const f of readdirSync(join(this.root, "docs", "decisions"))) {
            const m = /^D(\d+)/.exec(f);
            if (m) onDisk = Math.max(onDisk, Number(m[1]));
          }
        } catch {
          // no decisions folder yet
        }
      }
      const { r } = this.db
        .query(`SELECT COALESCE(MAX(value), 0) AS r FROM reservations WHERE kind = ?`)
        .get(kind) as { r: number };
      const value = Math.max(onDisk, r) + 1;
      this.db
        .query(`INSERT INTO reservations (kind, value, task_id, actor, at) VALUES (?, ?, ?, ?, ?)`)
        .run(kind, value, taskId ?? null, actor.name, this.now());
      this.event(taskId ?? null, actor, "reserved", { kind, value });
      return value;
    });
  }
}
