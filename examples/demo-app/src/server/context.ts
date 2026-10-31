// What a route is, and the helpers every handler uses.
import type { z } from "zod";
import { logLine, publicMessage, SafeError } from "../lib/errors";

export interface RouteContext {
  req: Request;
  url: URL;
  /** Values of `:name` segments in the route's path. */
  params: Record<string, string>;
}

/**
 * Every route says how an agent reaches it: the MCP tool that wraps it, or why none does.
 * test/parity.test.ts enforces it, so a new endpoint can't quietly be left out.
 */
export type McpExposure = { tool: string; description: string; input?: z.ZodType } | { skip: string };

export interface Route {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** e.g. "/api/items/:id" */
  path: string;
  handler: (ctx: RouteContext) => Response | Promise<Response>;
  mcp: McpExposure;
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers });
}

/** A failure shown to the client as `{ error }` with this status. */
export class ApiFailure extends SafeError {}

export function errorResponse(e: unknown): Response {
  const { message, status } = publicMessage(e);
  if (status >= 500) console.error(logLine(e));
  return json({ error: message }, status);
}

/** The request's JSON body, or a 400. */
export async function body(req: Request): Promise<unknown> {
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) throw new ApiFailure("expected a JSON body", 415);
  try {
    return await req.json();
  } catch {
    throw new ApiFailure("body is not valid JSON", 400);
  }
}

/** Validate with a zod schema; a failure is a 400 naming each field: "name: Too small". */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const msg = r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
  throw new ApiFailure(msg, 400);
}
