// The app's configuration: every environment variable it reads, in one schema.
// Each one is listed in docs/configuration.md (docs-check fails if they drift).
import { z } from "zod";

// An empty value ("FOO=") means unset, so defaults apply and `.optional()` holds.
const blank = (v: unknown) => (v === "" ? undefined : v);
const opt = <T extends z.ZodType>(t: T) => z.preprocess(blank, t.optional());

export const EnvSchema = z.object({
  DATABASE_URL: opt(z.string().regex(/^postgres(ql)?:\/\//, "must be a postgres:// URL")),
  APP_URL: z.preprocess(blank, z.url().default("http://localhost:3000")),
  PORT: z.preprocess(blank, z.coerce.number().int().min(1).max(65535).default(3000)),
  APP_VERSION: z.preprocess(blank, z.string().default("dev")),
});

export type Env = z.infer<typeof EnvSchema>;

// Read by name (not by passing process.env whole), so docs-check can list what's read.
const raw = () => ({
  DATABASE_URL: process.env.DATABASE_URL,
  APP_URL: process.env.APP_URL,
  PORT: process.env.PORT,
  APP_VERSION: process.env.APP_VERSION,
});

let cached: Env | undefined;

/** The parsed environment, read once. Errors name the bad fields, never their values. */
export function env(): Env {
  if (cached) return cached;
  const r = EnvSchema.safeParse(raw());
  if (!r.success) {
    const fields = [...new Set(r.error.issues.map((i) => i.path.join(".")))];
    throw new Error(`invalid configuration: ${fields.join(", ")} (see docs/configuration.md)`);
  }
  return (cached = r.data);
}

/** Forget the cached environment (tests change process.env). */
export function resetEnv(): void {
  cached = undefined;
}

/** The environment, with these optional keys guaranteed to be set. */
export function requireEnv<K extends keyof Env>(...keys: K[]): Env & { [P in K]-?: NonNullable<Env[P]> } {
  const e = env();
  const missing = keys.filter((k) => e[k] === undefined);
  if (missing.length) throw new Error(`missing configuration: ${missing.join(", ")} (see docs/configuration.md)`);
  return e as Env & { [P in K]-?: NonNullable<Env[P]> };
}
