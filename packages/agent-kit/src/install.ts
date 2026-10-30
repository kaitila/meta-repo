// Install agent-kit's templates into a repository (D0003, D0005).
// Never overwrites a file the project already has. The one exception is
// .claude/settings.json: its permission lists are merged (union), so a project
// keeps its own rules and gains the baseline's.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export const TEMPLATES = join(import.meta.dir, "..", "templates");

type Settings = { permissions?: Record<string, string[] | unknown> } & Record<string, unknown>;
type HookGroup = { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] };

export interface InstallResult {
  created: string[];
  merged: string[]; // settings files whose permission lists gained rules
  kept: string[]; // files left alone because the project already has them
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of new Bun.Glob("**/*").scanSync({ cwd: dir, dot: true, onlyFiles: true })) {
    out.push(entry);
  }
  return out.sort();
}

/** Union of each permission list; the project's own order first, new rules after. */
export function mergeSettings(project: Settings, baseline: Settings): { settings: Settings; added: number } {
  const merged: Settings = { ...baseline, ...project };
  const perms: Record<string, unknown> = { ...(baseline.permissions ?? {}), ...(project.permissions ?? {}) };
  let added = 0;
  for (const key of ["deny", "ask", "allow"]) {
    const mine = (project.permissions?.[key] as string[] | undefined) ?? [];
    const theirs = (baseline.permissions?.[key] as string[] | undefined) ?? [];
    const extra = theirs.filter((r) => !mine.includes(r));
    added += extra.length;
    if (mine.length || extra.length) perms[key] = [...mine, ...extra];
  }
  merged.permissions = perms;
  // Hooks: add each baseline hook group whose command the project doesn't run yet.
  const hooks: Record<string, HookGroup[]> = { ...((project.hooks as Record<string, HookGroup[]>) ?? {}) };
  for (const [event, groups] of Object.entries((baseline.hooks as Record<string, HookGroup[]>) ?? {})) {
    const mineGroups = hooks[event] ?? [];
    const have = new Set(mineGroups.flatMap((g) => g.hooks.map((h) => h.command)));
    const extra = groups.filter((g) => !g.hooks.every((h) => have.has(h.command)));
    added += extra.length;
    if (mineGroups.length || extra.length) hooks[event] = [...mineGroups, ...extra];
  }
  if (Object.keys(hooks).length) merged.hooks = hooks;
  return { settings: merged, added };
}

export function install(target: string, templates = TEMPLATES): InstallResult {
  const result: InstallResult = { created: [], merged: [], kept: [] };
  for (const rel of walk(templates)) {
    const src = join(templates, rel);
    const dst = join(target, rel);
    const shown = relative(target, dst);
    if (rel === join(".claude", "settings.json") && existsSync(dst)) {
      const { settings, added } = mergeSettings(
        JSON.parse(readFileSync(dst, "utf8")),
        JSON.parse(readFileSync(src, "utf8")),
      );
      if (added) {
        writeFileSync(dst, JSON.stringify(settings, null, 2) + "\n");
        result.merged.push(shown);
      } else result.kept.push(shown);
      continue;
    }
    if (existsSync(dst)) {
      result.kept.push(shown);
      continue;
    }
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, readFileSync(src));
    result.created.push(shown);
  }
  return result;
}
