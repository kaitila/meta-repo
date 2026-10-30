#!/usr/bin/env bun
// PreToolUse guard (agent-kit, D0007). Claude Code runs it before Bash, file edits
// and reads. Exit 2 blocks the call and shows the reason to the agent.
//
// What it blocks:
//   - git push to main/master, force-push (any spelling), --no-verify; git reset --hard
//   - recursive force rm in any spelling
//   - reading or writing .env files (not .env.example), also through `bash -c` and
//     inline scripts (`bun -e`, `node -e`, `python -c`, ...)
//   - edits outside the paths of the foreman task this agent has claimed, through the
//     edit tools or the shell (redirects, tee, cp, mv, install, touch, sed -i)
//
// It parses commands, so quoted text that only mentions `.env` is fine.
// It fails closed: a payload it can't read is blocked, and so is an edit whose task
// paths can't be checked because foreman is unreachable.
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
  /**
   * Globs the agent's claimed tasks allow, or null when no task restricts paths.
   * Throws when it should know but can't (FOREMAN_ACTOR set, foreman unreachable).
   */
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

export interface SimpleCommand {
  words: string[]; // quotes removed; input-redirect targets included ("cat < .env" → cat .env)
  writes: string[]; // output-redirect targets ("echo x > out.txt" → out.txt)
  heredocs: string[]; // here-document bodies: data, unless the command is a shell
}

/** Split a command line into simple commands, each a list of words with quotes removed. */
export function parseShell(src: string): string[][] {
  return parseCommands(src).map((c) => c.words);
}

export function parseCommands(src: string): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let words: string[] = [];
  let writes: string[] = [];
  let word = "";
  let inWord = false;
  let redirectOut = false;
  let heredocs: string[] = [];
  // Here-documents declared on the current line: their bodies start after the newline.
  const pending: { delim: string; strip: boolean; quoted: boolean; into: string[] }[] = [];
  const endWord = () => {
    if (inWord) (redirectOut ? writes : words).push(word);
    if (inWord) redirectOut = false;
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length || writes.length || heredocs.length) commands.push({ words, writes, heredocs });
    words = [];
    writes = [];
    heredocs = [];
  };
  /** Read the bodies of pending here-documents starting at `from`; returns where parsing resumes. */
  const readBodies = (from: number): number => {
    let pos = from;
    for (const { delim, strip, quoted, into } of pending) {
      const lines: string[] = [];
      for (;;) {
        if (pos >= src.length) break; // unterminated: the rest is the body, as bash does
        const nl = src.indexOf("\n", pos);
        const end = nl < 0 ? src.length : nl;
        const raw = src.slice(pos, end);
        pos = end + 1;
        if ((strip ? raw.replace(/^\t+/, "") : raw) === delim) break;
        lines.push(raw);
      }
      const body = lines.join("\n");
      into.push(body);
      // An unquoted delimiter means the shell expands $(...) and backticks in the body.
      if (!quoted) for (const sub of substitutions(body)) for (const cmd of parseCommands(sub)) commands.push(cmd);
    }
    pending.length = 0;
    return pos - 1; // the loop's i++ lands on the first character after the bodies
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
      let str = "";
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === "\\" && j + 1 < src.length) str += src[++j];
        else str += src[j];
      }
      if (j >= src.length) throw new Error('unclosed "');
      word += str;
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
      for (const sub of parseCommands(src.slice(i + 2, j - 1))) commands.push(sub);
      word += "$(...)";
      inWord = true;
      i = j - 1;
    } else if (c === "`") {
      const j = src.indexOf("`", i + 1);
      if (j < 0) throw new Error("unclosed `");
      for (const sub of parseCommands(src.slice(i + 1, j))) commands.push(sub);
      i = j;
    } else if (c === ">") {
      // Output redirection. A file-descriptor number right before it ("2>") isn't a word,
      // and ">&1" duplicates a descriptor rather than naming a file.
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else endWord();
      while (src[i + 1] === ">") i++;
      if (src[i + 1] === "&") {
        i++;
        while (/[\d-]/.test(src[i + 1] ?? "")) i++;
      } else redirectOut = true;
    } else if (c === "<" && src[i + 1] === "<" && src[i + 2] === "<") {
      // Here-string: the next word is data, kept as an ordinary word.
      endWord();
      i += 2;
    } else if (c === "<" && src[i + 1] === "<") {
      // Here-document: <<EOF, <<'EOF', <<"EOF", <<-EOF. The body follows the line.
      endWord();
      i += 2;
      const strip = src[i] === "-";
      if (strip) i++;
      while (src[i] === " " || src[i] === "\t") i++;
      let delim = "";
      const quoted = src[i] === "'" || src[i] === '"';
      if (quoted) {
        const q = src[i]!;
        const j = src.indexOf(q, i + 1);
        if (j < 0) throw new Error(`unclosed ${q}`);
        delim = src.slice(i + 1, j);
        i = j;
      } else {
        while (i < src.length && !/[\s;&|<>()]/.test(src[i]!)) delim += src[i++];
        i--;
      }
      if (!delim) throw new Error("here-document without a delimiter");
      pending.push({ delim, strip, quoted, into: heredocs });
    } else if (c === "<") {
      // Input redirection: its target is an ordinary word ("cat < .env").
      endWord();
    } else if (c === "\n" && pending.length) {
      // The line that declared here-documents ends: read their bodies, then the command ends.
      i = readBodies(i + 1);
      endCommand();
    } else if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "(" || c === ")") {
      endCommand();
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

/** The command substitutions inside text the shell expands: `$(...)` and backticks. */
function substitutions(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "$" && text[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      for (; j < text.length && depth; j++) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")") depth--;
      }
      out.push(text.slice(i + 2, j - 1));
      i = j - 1;
    } else if (text[i] === "`") {
      const j = text.indexOf("`", i + 1);
      if (j < 0) break;
      out.push(text.slice(i + 1, j));
      i = j;
    }
  }
  return out;
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

/** Files a command writes to, for the commands that commonly write files. */
export function writeTargets(head: string, args: string[]): string[] {
  const plain = (xs: string[]) => xs.filter((a) => !a.startsWith("-"));
  if (head === "tee" || head === "touch") return plain(args);
  if (head === "cp" || head === "mv" || head === "install" || head === "ln") {
    const t = args.findIndex((a) => a === "-t" || a === "--target-directory");
    if (t >= 0 && args[t + 1]) return [args[t + 1]!];
    const longT = args.find((a) => a.startsWith("--target-directory="));
    if (longT) return [longT.split("=")[1]!];
    const rest = plain(args);
    return rest.length >= 2 ? [rest[rest.length - 1]!] : [];
  }
  if (head === "sed" && args.some((a) => a === "-i" || a.startsWith("-i") || a.startsWith("--in-place"))) {
    // The script is the first plain word unless given with -e/-f.
    const out: string[] = [];
    let scriptGiven = false;
    for (let k = 0; k < args.length; k++) {
      const a = args[k]!;
      if (a === "-e" || a === "-f" || a === "--expression" || a === "--file") {
        scriptGiven = true;
        k++;
      } else if (!a.startsWith("-")) {
        if (!scriptGiven) scriptGiven = true;
        else out.push(a);
      }
    }
    return out;
  }
  return [];
}

function inlineCode(head: string, args: string[]): string[] {
  // `bun -e '...'`, `node -e`, `python -c`, `perl -e`, ...: the code is text we must scan.
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    if (["-e", "-c", "--eval", "-p", "--print", "-E"].includes(args[k]!) && args[k + 1] !== undefined) out.push(args[++k]!);
  }
  return INTERPRETERS.has(head) ? out : [];
}

/** Code (not shell) that names a .env file in a string literal. */
function codeReadsEnv(code: string): boolean {
  const m = code.match(/["'`]([^"'`]*\.env(\.[A-Za-z0-9_.-]+)?)["'`]/g) ?? [];
  return m.some((s) => isEnvFile(s.slice(1, -1)));
}

export function checkCommand(command: string, ctx: Context, depth = 0): string | null {
  if (depth > 3) return "command nests shells too deeply to check";
  let commands: SimpleCommand[];
  try {
    commands = parseCommands(command);
  } catch (e) {
    return `couldn't parse the command (${(e as Error).message})`;
  }
  // Here-document bodies run as code when anything in the command line reads a script
  // from stdin: `bash <<EOF`, `cat <<EOF | bash`, `source /dev/stdin <<EOF`.
  const heads = commands.map((c) => {
    const w = unwrap(c.words);
    return { head: w[0] ? basename(w[0]) : "", args: w.slice(1) };
  });
  const bodies = commands.flatMap((c) => c.heredocs);
  if (bodies.length) {
    const runsStdin = heads.some(
      (h) => (SHELLS.has(h.head) && !h.args.includes("-c")) || ((h.head === "source" || h.head === ".") && h.args[0] === "/dev/stdin"),
    );
    if (runsStdin) {
      for (const body of bodies) {
        const r = checkCommand(body, ctx, depth + 1);
        if (r) return r;
      }
    }
    // An interpreter fed a heredoc (`python3 <<EOF`) runs it as code we can't parse: scan it like `-e` code.
    if (heads.some((h) => INTERPRETERS.has(h.head)) && bodies.some(codeReadsEnv)) return "inline code reads a .env file";
  }
  for (const { words: raw, writes } of commands) {
    for (const target of writes) {
      const r = editRule(target, ctx);
      if (r) return r;
    }
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
      if (codeReadsEnv(code)) return "inline code reads a .env file";
    }
    for (const target of writeTargets(head, args)) {
      const r = editRule(target, ctx);
      if (r) return r;
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
  let paths: string[] | null;
  try {
    paths = ctx.taskPaths();
  } catch (e) {
    return `can't check your task's paths: ${(e as Error).message}`;
  }
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
  let cached: string[] | null | undefined;
  const projectRoot = process.env.CLAUDE_PROJECT_DIR || sh(["git", "rev-parse", "--show-toplevel"], cwd) || cwd;
  return {
    projectRoot,
    cwd,
    branchAt: (dir) => sh(["git", "branch", "--show-current"], dir),
    taskPaths: () => {
      if (cached !== undefined) return cached;
      if (!process.env.FOREMAN_ACTOR) return (cached = null); // no identity, no task to hold to
      // With an identity set, not knowing the task's paths is an error, not a free pass.
      const fm = foremanCmd(projectRoot);
      if (!fm) throw new Error("FOREMAN_ACTOR is set but foreman isn't installed (set FOREMAN_BIN)");
      const out = sh([...fm, "list", "--mine", "--status", "claimed", "--status", "in_progress", "--json"], projectRoot);
      if (out === null) throw new Error(`FOREMAN_ACTOR is set but \`${fm.join(" ")} list\` failed`);
      let tasks: { paths: string[] }[];
      try {
        tasks = JSON.parse(out);
      } catch {
        throw new Error("foreman's answer wasn't JSON");
      }
      if (!tasks.length || tasks.some((t) => t.paths.length === 0)) return (cached = null);
      return (cached = tasks.flatMap((t) => t.paths));
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
