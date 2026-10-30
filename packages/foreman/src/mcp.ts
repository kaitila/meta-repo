// foreman's MCP server (stdio). Same core as the CLI. Everyone calling through
// MCP is an agent, so there is no approve tool here: sign-off is for people (D0002).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { type Actor, Foreman, ForemanError, type Status } from "./core";
import { toMarkdown } from "./export";

const STATUSES = [
  "draft", "ready", "claimed", "in_progress", "in_review", "verifying",
  "needs_approval", "approved", "done", "cancelled",
] as const;

export function buildServer(f: Foreman, me: Actor): McpServer {
  const server = new McpServer({ name: "foreman", version: "0.1.0" });
  const ok = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
  const wrap =
    <A>(fn: (a: A) => unknown) =>
    async (a: A) => {
      try {
        return ok(await fn(a));
      } catch (e) {
        if (e instanceof ForemanError) {
          return { isError: true, content: [{ type: "text" as const, text: `${e.code}: ${e.message}` }] };
        }
        throw e;
      }
    };
  const id = { id: z.string().describe("Task id, e.g. T-0001") };

  server.registerTool(
    "list_tasks",
    { description: "List tasks, optionally by status.", inputSchema: { status: z.array(z.enum(STATUSES)).optional() } },
    wrap(({ status }: { status?: Status[] }) => f.list({ status })),
  );
  server.registerTool(
    "next_tasks",
    { description: "Ready tasks whose blockers are done: what an agent can claim now.", inputSchema: {} },
    wrap(() => f.ready("agent")),
  );
  server.registerTool(
    "show_task",
    { description: "One task as markdown: spec, acceptance checks, history.", inputSchema: id },
    wrap(({ id }: { id: string }) => toMarkdown(f.get(id), f.events(id))),
  );
  server.registerTool(
    "create_task",
    {
      description:
        "File a task. Search with list_tasks first so you don't file a duplicate. Work you found while doing another task: set discoveredFrom.",
      inputSchema: {
        title: z.string(),
        spec: z.string().optional().describe("Markdown: what and why"),
        acceptance: z
          .array(z.string())
          .optional()
          .describe('Checks: "cmd: <command that must exit 0>" or "statement: <claim to verify>"'),
        paths: z.array(z.string()).optional().describe("Globs the task may touch"),
        risk: z.enum(["auto", "review", "human"]).optional(),
        parent: z.string().optional(),
        blockedBy: z.array(z.string()).optional(),
        discoveredFrom: z.string().optional(),
        ready: z.boolean().optional(),
      },
    },
    wrap((a: Parameters<Foreman["create"]>[0]) => f.create(a, me)),
  );
  server.registerTool(
    "claim_task",
    {
      description: "Claim a task (or the next ready one if id is omitted). Keep it alive with heartbeat or progress.",
      inputSchema: { id: z.string().optional(), leaseMinutes: z.number().int().positive().optional() },
    },
    wrap(({ id, leaseMinutes }: { id?: string; leaseMinutes?: number }) => f.claim(id ?? null, me, leaseMinutes)),
  );
  server.registerTool(
    "heartbeat",
    { description: "Keep your claim alive.", inputSchema: id },
    wrap(({ id }: { id: string }) => f.heartbeat(id, me)),
  );
  server.registerTool(
    "report_progress",
    {
      description: "Record progress on a task you hold (also renews the lease).",
      inputSchema: { ...id, note: z.string().optional(), branch: z.string().optional(), worktree: z.string().optional() },
    },
    wrap(({ id, ...p }: { id: string; note?: string; branch?: string; worktree?: string }) => f.progress(id, me, p)),
  );
  server.registerTool(
    "submit_task",
    {
      description: "Hand in your PR. You let go of the task; someone else verifies it.",
      inputSchema: { ...id, pr: z.string(), summary: z.string().optional() },
    },
    wrap(({ id, pr, summary }: { id: string; pr: string; summary?: string }) => f.submit(id, me, { pr, summary })),
  );
  server.registerTool(
    "start_verify",
    { description: "Take a submitted task to verify. Refused if you worked on it.", inputSchema: id },
    wrap(({ id }: { id: string }) => f.startVerify(id, me)),
  );
  server.registerTool(
    "record_verdict",
    {
      description:
        "Your verdict on a task you are verifying: one result per acceptance check. Run cmd checks yourself; never trust the worker's summary.",
      inputSchema: {
        ...id,
        results: z.array(z.object({ check: z.string(), pass: z.boolean(), evidence: z.string() })),
      },
    },
    wrap(({ id, results }: { id: string; results: { check: string; pass: boolean; evidence: string }[] }) =>
      f.recordVerify(id, me, results),
    ),
  );
  server.registerTool(
    "mark_merged",
    { description: "An approved task's PR was merged.", inputSchema: { ...id, pr: z.string().optional() } },
    wrap(({ id, pr }: { id: string; pr?: string }) => f.merged(id, me, pr)),
  );
  server.registerTool(
    "reserve_number",
    {
      description: 'Reserve the next number of a kind ("decision", "migration") so parallel PRs never clash.',
      inputSchema: { kind: z.string(), task: z.string().optional() },
    },
    wrap(({ kind, task }: { kind: string; task?: string }) => ({ kind, value: f.reserve(kind, me, task) })),
  );
  return server;
}

export async function serve() {
  const me: Actor = { name: process.env.FOREMAN_ACTOR || `mcp-${process.pid}`, kind: "agent" };
  await buildServer(Foreman.open(), me).connect(new StdioServerTransport());
}
