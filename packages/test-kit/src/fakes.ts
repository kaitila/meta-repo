// Fakes for the outside world: network and LLM. A test must never reach a real API
// or spend money, so anything a fake doesn't expect is an error, not a passthrough.

export type FetchRoute = (url: URL, init?: RequestInit) => Response | undefined | Promise<Response | undefined>;

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const text = (body: string, status = 200) => new Response(body, { status });

/** Route helpers: `on("GET", "https://api.example.com/v1/items", () => json([...]))`. */
export function on(method: string, prefix: string, reply: (url: URL, init?: RequestInit) => Response | Promise<Response>): FetchRoute {
  return (url, init) =>
    (init?.method ?? "GET").toUpperCase() === method.toUpperCase() && url.toString().startsWith(prefix) ? reply(url, init) : undefined;
}

export interface FakeFetch {
  /** Every request made, in order. */
  calls: { url: string; method: string; body?: string }[];
  restore(): void;
  /** The fetch function itself, for apps that take one instead of using the global. */
  fetch: typeof fetch;
}

/**
 * Replace `globalThis.fetch` (or hand the function to the app's own seam) with routes
 * tried in order. A request no route answers throws "unexpected request in test".
 */
export function installFetch(routes: FetchRoute[], opts: { global?: boolean } = {}): FakeFetch {
  const calls: FakeFetch["calls"] = [];
  const original = globalThis.fetch;
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    calls.push({ url: url.toString(), method, body: typeof init?.body === "string" ? init.body : undefined });
    for (const r of routes) {
      const res = await r(url, { ...init, method });
      if (res) return res;
    }
    throw new Error(`unexpected request in test: ${method} ${url.origin}${url.pathname}`);
  }) as typeof fetch;
  if (opts.global !== false) globalThis.fetch = fake;
  return {
    calls,
    fetch: fake,
    restore: () => {
      if (opts.global !== false) globalThis.fetch = original;
    },
  };
}

export interface LlmRequest {
  system?: string;
  user: string;
  [k: string]: unknown;
}
export interface LlmReply {
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}
export interface LlmRule {
  match: RegExp | ((req: LlmRequest) => boolean);
  /** A string, an object (sent as JSON), or a function of the request. */
  reply: string | object | ((req: LlmRequest) => string | object);
}

/**
 * A fake model: the first rule whose `match` fits the prompt answers. Hand it to the
 * app's LLM seam (the app keeps its budget guard and call logging on top of it).
 */
export function fakeLlm(rules: LlmRule[], opts: { otherwise?: "throw" | string } = {}) {
  const calls: { model: string; req: LlmRequest }[] = [];
  const converse = async (model: string, req: LlmRequest): Promise<LlmReply> => {
    calls.push({ model, req });
    const prompt = `${req.system ?? ""}\n${req.user}`;
    const rule = rules.find((r) => (r.match instanceof RegExp ? r.match.test(prompt) : r.match(req)));
    let out: string | object;
    if (rule) out = typeof rule.reply === "function" ? rule.reply(req) : rule.reply;
    else if (opts.otherwise && opts.otherwise !== "throw") out = opts.otherwise;
    else throw new Error(`fakeLlm: no rule matches the prompt: ${prompt.slice(0, 120)}`);
    const t = typeof out === "string" ? out : JSON.stringify(out);
    return { text: t, model, usage: { inputTokens: Math.ceil(prompt.length / 4), outputTokens: Math.ceil(t.length / 4) } };
  };
  return { converse, calls };
}

/**
 * Delete env vars that hold real credentials, so no test can reach a real service even
 * when a developer's .env is loaded. Returns the names removed.
 */
export function stripCredentials(patterns: (string | RegExp)[], env: Record<string, string | undefined> = process.env): string[] {
  const res = patterns.map((p) => (typeof p === "string" ? new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")}$`) : p));
  const gone = Object.keys(env).filter((k) => res.some((r) => r.test(k)));
  for (const k of gone) delete env[k];
  return gone;
}

/** Typical credential names: API keys, secrets, tokens, cloud keys. */
export const COMMON_CREDENTIALS = [/_(API_KEY|SECRET|TOKEN|PASSWORD)$/, /^AWS_/, /^ANTHROPIC_API_KEY$/, /^OPENAI_API_KEY$/];
