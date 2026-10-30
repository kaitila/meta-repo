#!/usr/bin/env bun
// PreToolUse guard (agent-kit, D0007). Claude Code runs it before Bash, file edits
// and reads. Exit 2 blocks the call and shows the reason to the agent.
//
// What it blocks:
//   - git push to main/master, force-push (any spelling), --no-verify; git reset --hard
//   - recursive force rm in any spelling
//   - reading or writing .env files (not .env.example), also through `bash -c` and
//     inline scripts (`bun -e`, `node -e`, `python -c`, ...)
//   - edits outside the paths of the foreman task this agent has claimed
//
// It parses commands, so quoted text that only mentions `.env` is fine.
// It fails closed: a payload it can't read is blocked.
// Self-contained on purpose: a project gets a copy, with no package to install.
import { relative, resolve, basename, isAbsolute } from "node:path";

export interface Decision {
  deny: string;
}

export interface Context {
  projectRoot: string;
  cwd: string;
  /** Current branch of the repo at `dir`, or null if unknown. */
  branchAt: (dir: string) => string | null;
  /** Globs the agent's claimed tasks allow, or null when no task restricts paths. */
  taskPaths: () => string[] | null;
}

const PROTECTED = new Set(["main", "master"]);
const ENV_FILE = /(^|\/)\.env(\.[A-Za-z0-9_.-]+)?$/;
const ENV_OK = /(^|\/)\.env\.(example|sample|template|dist)$/;
const INTERPRETERS = new Set(["bun", "node", "deno", "python", "python3", "perl", "ruby", "php"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
const WRAPPERS = new Set(["sudo", "env", "command", "builtin", "nice", "nohup", "time", "timeout", "stdbuf", "xargs", "exec"]);
// Files a worker may always touch, whatever its task's paths say.
const ALWAYS_EDITABLE = ["docs/tasks/**"];

export const isEnvFile = (p: string) => ENV_FILE.test(p) && !ENV_OK.test(p);

// ---------- shell parsing (enough of it: words, quotes, separators, redirections) ----------

/** Split a command line into simple commands, each a list of words with quotes removed. */
export function parseShell(src: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\" && i + 1 < src.length) {
      word += src[++i];
      inWord = true;
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) throw new Error("unclosed '");
      word += src.slice(i + 1, j);
      inWord = true;
      i = j;
    } else if (c === '"') {
      let j = i + 1;
      let s = "";
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === "\\" && j + 1 < src.length) s += src[++j];
        else s += src[j];
      }
      if (j >= src.length) throw new Error('unclosed "');
      word += s;
      inWord = true;
      i = j;
    } else if (c === "$" && src[i + 1] === "(") {
      // Command substitution: analyse its contents as commands of their own.
      let depth = 1;
      let j = i + 2;
      for (; j < src.length && depth; j++) {
        if (src[j] === "(") depth++;
        else if (src[j] === ")") depth--;
      }
      for (const sub of parseShell(src.slice(i + 2, j - 1))) commands.push(sub);
      word += "$(...)";
      inWord = true;
      i = j - 1;
    } else if (c === "`") {
      const j = src.indexOf("`", i + 1);
      if (j < 0) throw new Error("unclosed `");
      for (const sub of parseShell(src.slice(i + 1, j))) commands.push(sub);
      i = j;
    } else if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "(" || c === ")") {
      endCommand();
    } else if (c === "<" || c === ">") {
      // A redirection: its target is a word of its own ("cat < .env", "echo x > .env").
      endWord();
      while (src[i + 1] === ">" || src[i + 1] === "&") i++;
    } else if (c === " " || c === "\t") {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

/** Drop `VAR=value` prefixes and wrappers such as `sudo`, `timeout 10`, `env -i`. */
function unwrap(words: string[]): string[] {
  let w = [...words];
  for (;;) {
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!)) w.shift();
    const head = w[0] ? basename(w[0]) : "";
    if (!WRAPPERS.has(head)) return w;
    w.shift();
    while (w.length && (w[0]!.startsWith("-") || /^\d+[smhd]?$/.test(w[0]!))) w.shift();
  }
}

// ---------- rules ----------

function gitRule(args: string[], ctx: Context): string | null {
  // Global options come before the subcommand: -C <dir>, -c k=v, --git-dir=..., --no-pager.
  let dir = ctx.cwd;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-C") dir = resolve(dir, args[++i] ?? ".");
    else if (a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "--namespace") i++;
    else if (a.startsWith("-")) continue;
    else break;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  const shortFlags = (s: string) => /^-[A-Za-z]+$/.test(s);

  if (sub === "push") {
    const positional: string[] = [];
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k]!;
      if (a === "--no-verify") return "git push --no-verify skips the hooks";
      if (a === "--force" || a.startsWith("--force-with-lease") || a.startsWith("--force-if-includes") || a === "--mirror")
        return "force-push rewrites history others may have";
      if (shortFlags(a) && a.includes("f")) return "force-push rewrites history others may have";
      if (a === "--delete" || (shortFlags(a) && a.includes("d"))) return "deleting a remote branch needs a person";
      if (a === "-o" || a === "--push-option" || a === "--repo" || a === "--receive-pack" || a === "--exec") {
        k++;
        continue;
      }
      if (a.startsWith("-")) continue;
      positional.push(a);
    }
    const refspecs = positional.slice(1); // first positional is the remote
    for (const r of refspecs) {
      if (r.startsWith("+")) return `"${r}" force-pushes`;
      if (r.startsWith(":")) return "deleting a remote branch needs a person";
      const target = (r.includes(":") ? r.split(":").pop()! : r).replace(/^refs\/heads\//, "");
      if (PROTECTED.has(target)) return `pushing to ${target} goes through a PR`;
      if (target === "HEAD" && PROTECTED.has(ctx.branchAt(dir) ?? "")) return "pushing to main goes through a PR";
    }
    if (refspecs.length === 0) {
      const branch = ctx.branchAt(dir);
      if (branch && PROTECTED.has(branch)) return `you're on ${branch}: push a branch and open a PR`;
    }
    return null;
  }
  if (sub === "commit" || sub === "merge" || sub === "am" || sub === "rebase" || sub === "cherry-pick") {
    const takesValue = new Set(["-m", "-F", "-C", "-c", "-t", "--message", "--file", "--author", "--date", "--template", "--cleanup", "--trailer", "--fixup", "--squash", "-S", "--gpg-sign", "-s", "--strategy", "-X", "--strategy-option"]);
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k]!;
      if (a === "--no-verify") return `git ${sub} --no-verify skips the hooks`;
      if (takesValue.has(a)) {
        k++;
        continue;
      }
      // -n is --no-verify for commit; in a cluster ("-nm msg", "-an") the letters before
      // a value-taking letter are flags.
      if (sub === "commit" && shortFlags(a)) {
        const flags = a.slice(1);
        const stop = flags.search(/[mFCct]/);
        if ((stop < 0 ? flags : flags.slice(0, stop)).includes("n")) return "git commit -n skips the hooks";
      }
    }
    return null;
  }
  if (sub === "reset" && rest.includes("--hard")) return "git reset --hard throws work away; use git stash or ask";
  if (sub === "clean" && rest.some((a) => a === "--force" || (shortFlags(a) && a.includes("f"))))
    return "git clean -f deletes untracked files; ask first";
  return null;
}

function rmRule(args: string[]): string | null {
  let recursive = false;
  let force = false;
  for (const a of args) {
    if (a === "--") break;
    if (a === "--recursive") recursive = true;
    else if (a === "--force") force = true;
    else if (/^-[A-Za-z]+$/.test(a)) {
      if (/[rR]/.test(a)) recursive = true;
      if (a.includes("f")) force = true;
    }
  }
  return recursive && force ? "recursive force rm is denied here; use the tool's own clean command or ask" : null;
}

function inlineCode(head: string, args: string[]): string[] {
  // `bun -e '...'`, `node -e`, `python -c`, `perl -e`, ...: the code is text we must scan.
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    if (["-e", "-c", "--eval", "-p", "--print", "-E"].includes(args[k]!) && args[k + 1] !== undefined) out.push(args[++k]!);
  }
  return INTERPRETERS.has(head) ? out : [];
}

export function checkCommand(command: string, ctx: Context, depth = 0): string | null {
  if (depth > 3) return "command nests shells too deeply to check";
  let commands: string[][];
  try {
    commands = parseShell(command);
  } catch (e) {
    return `couldn't parse the command (${(e as Error).message})`;
  }
  for (const raw of commands) {
    const words = unwrap(raw);
    if (!words.length) continue;
    const head = basename(words[0]!);
    const args = words.slice(1);
    if (head === "git") {
      const r = gitRule(args, ctx);
      if (r) return r;
    }
    if (head === "rm") {
      const r = rmRule(args);
      if (r) return r;
    }
    if (SHELLS.has(head) || head === "eval") {
      const ci = args.indexOf("-c");
      const script = head === "eval" ? args.join(" ") : ci >= 0 ? args[ci + 1] : undefined;
      if (script) {
        const r = checkCommand(script, ctx, depth + 1);
        if (r) return r;
      }
    }
    for (const code of inlineCode(head, args)) {
      const m = code.match(/["'`]([^"'`]*\.env(\.[A-Za-z0-9_.-]+)?)["'`]/g) ?? [];
      if (m.some((s) => isEnvFile(s.slice(1, -1)))) return "inline code reads a .env file";
    }
    // Any argument that IS a .env path (not text that mentions one).
    const envArg = args.find((a) => !a.includes(" ") && isEnvFile(a.replace(/^[<>]+/, "")));
    if (envArg && head !== "echo" && head !== "printf") return `${envArg} holds secrets: agents don't read or copy it`;
  }
  return null;
}

function editRule(path: string, ctx: Context): string | null {
  if (isEnvFile(path)) return `${basename(path)} holds secrets: agents don't write it`;
  const abs = isAbsolute(path) ? path : resolve(ctx.cwd, path);
  const rel = relative(ctx.projectRoot, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null; // outside the repo: not a task's business
  const paths = ctx.taskPaths();
  if (!paths || paths.length === 0) return null;
  const ok = [...paths, ...ALWAYS_EDITABLE].some((g) => new Bun.Glob(g).match(rel));
  return ok ? null : `${rel} is outside your task's paths (${paths.join(", ")}); file a task for it instead`;
}

export function decide(payload: { tool_name?: string; tool_input?: Record<string, unknown> }, ctx: Context): Decision | null {
  const tool = payload.tool_name ?? "";
  const input = payload.tool_input ?? {};
  let reason: string | null = null;
  if (tool === "Bash") reason = checkCommand(String(input.command ?? ""), ctx);
  else if (tool === "Read") reason = isEnvFile(String(input.file_path ?? "")) ? ".env files hold secrets: agents don't read them" : null;
  else if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const p = String(input.file_path ?? input.notebook_path ?? "");
    reason = p ? editRule(p, ctx) : "edit without a file path";
  }
  return reason ? { deny: reason } : null;
}

// ---------- wiring for a real run ----------

function sh(cmd: string[], cwd: string): string | null {
  try {
    const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", timeout: 5000 });
    return p.exitCode === 0 ? p.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

/** foreman from $FOREMAN_BIN, the PATH, or this repo's own copy. */
function foremanCmd(root: string): string[] | null {
  if (process.env.FOREMAN_BIN) return process.env.FOREMAN_BIN.split(" ");
  if (Bun.which("foreman")) return ["foreman"];
  const local = resolve(root, "packages/foreman/src/cli.ts");
  return Bun.file(local).size ? ["bun", local] : null;
}

export function realContext(cwd: string): Context {
  const projectRoot = process.env.CLAUDE_PROJECT_DIR || sh(["git", "rev-parse", "--show-toplevel"], cwd) || cwd;
  return {
    projectRoot,
    cwd,
    branchAt: (dir) => sh(["git", "branch", "--show-current"], dir),
    taskPaths: () => {
      if (!process.env.FOREMAN_ACTOR) return null; // no identity, no task to hold to
      const fm = foremanCmd(projectRoot);
      if (!fm) return null;
      const out = sh([...fm, "list", "--mine", "--status", "claimed", "--status", "in_progress", "--json"], projectRoot);
      if (!out) return null;
      const tasks = JSON.parse(out) as { paths: string[] }[];
      if (!tasks.length || tasks.some((t) => t.paths.length === 0)) return null;
      return tasks.flatMap((t) => t.paths);
    },
  };
}

if (import.meta.main) {
  let payload: { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string };
  try {
    payload = JSON.parse(await Bun.stdin.text());
  } catch {
    console.error("guard: couldn't read the hook payload, blocking to be safe");
    process.exit(2);
  }
  try {
    const d = decide(payload, realContext(payload.cwd || process.cwd()));
    if (d) {
      console.error(`guard: ${d.deny}`);
      process.exit(2);
    }
  } catch (e) {
    console.error(`guard: internal error, blocking to be safe: ${(e as Error).message}`);
    process.exit(2);
  }
  process.exit(0);
}
