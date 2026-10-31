// One file per decision: docs/decisions/D0001-short-slug.md, starting with
//   # D0001. The decision as a sentence (2026-10-30)
//   **Status:** Active | Amended by D0002[, D0003] | Superseded by D0004 | Paused[ (D0005)]
// then **Context:** (optional), **Chosen:**, **Why:**, **Revisit if:** in that order.

export interface Decision {
  n: number;
  file: string; // repo-relative
  title: string;
  date: string;
  status: string;
  targets: number[];
}

export interface DecisionFailure {
  file: string;
  line: number;
  kind: string;
  target: string;
}

export interface DecisionOptions {
  dir: string;
  pad: number;
  sections: string[];
}

export const DEFAULT_DECISIONS: DecisionOptions = { dir: "docs/decisions", pad: 4, sections: ["Chosen", "Why", "Revisit if"] };

const STATUS_LINE = /^\*\*Status:\*\*\s*(.*?)\s*$/;

export function statusValue(pad: number): RegExp {
  const d = `D\\d{${pad}}`;
  return new RegExp(`^(?:Active|Paused(?: \\(${d}\\))?|Superseded by ${d}|Amended by ${d}(?:, ${d})*)$`);
}

/** A real calendar date in YYYY-MM-DD, not after today (UTC). */
export function validDate(s: string, today = new Date()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return false; // 2026-02-30 rolls over
  return s <= today.toISOString().slice(0, 10);
}

export function parseDecisions(
  files: { file: string; text: string }[],
  opts: DecisionOptions = DEFAULT_DECISIONS,
  today = new Date(),
): { decisions: Decision[]; failures: DecisionFailure[] } {
  const failures: DecisionFailure[] = [];
  const fail = (file: string, line: number, kind: string, target: string) => failures.push({ file, line, kind, target });
  const decisions: Decision[] = [];
  const nameRe = new RegExp(`^D(\\d{${opts.pad}})-[a-z0-9]+(?:-[a-z0-9]+)*\\.md$`);
  const headRe = new RegExp(`^# D(\\d{${opts.pad}})\\. (\\S.*?) \\(([^()]*)\\)$`);
  const status = statusValue(opts.pad);

  for (const { file, text } of files) {
    const name = file.split("/").pop()!;
    const nm = nameRe.exec(name);
    if (!nm) {
      fail(file, 0, "decision-file", `name must be D${"0".repeat(opts.pad - 1)}1-short-slug.md`);
      continue;
    }
    const n = Number(nm[1]);
    const lines = text.split("\n");
    const headAt = lines.findIndex((l) => l.trim() !== "");
    const hm = headRe.exec(lines[headAt] ?? "");
    if (!hm) {
      fail(file, headAt + 1, "decision-heading", "first line must be '# Dnnnn. Title (YYYY-MM-DD)'");
      continue;
    }
    if (Number(hm[1]) !== n) fail(file, headAt + 1, "decision-heading", `heading says D${hm[1]}, file name says D${nm[1]}`);
    const date = hm[3]!;
    if (!validDate(date, today)) fail(file, headAt + 1, "decision-date", date);

    const statusLines = lines.map((l, i) => [i, STATUS_LINE.exec(l)] as const).filter(([, m]) => m);
    let value = "none";
    let targets: number[] = [];
    if (statusLines.length !== 1) {
      fail(file, headAt + 1, "decision-status", statusLines.length ? "more than one status line" : "no **Status:** line");
    } else {
      const [at, m] = statusLines[0]!;
      value = m![1]!;
      const between = lines.slice(headAt + 1, at);
      if (between.some((l) => l.trim() !== "")) fail(file, at + 1, "decision-status", "status must come right after the heading");
      if (!status.test(value)) fail(file, at + 1, "decision-status", value || "(empty)");
      targets = [...value.matchAll(/\bD(\d+)\b/g)].map((x) => Number(x[1]));
    }

    // Sections in order, each once.
    let last = -1;
    for (const s of opts.sections) {
      const re = new RegExp(`^\\*\\*${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\*\\*`);
      const at = lines.flatMap((l, i) => (re.test(l) ? [i] : []));
      if (at.length !== 1) {
        fail(file, 0, "decision-section", at.length ? `**${s}:** appears ${at.length} times` : `no **${s}:** section`);
        continue;
      }
      if (at[0]! < last) fail(file, at[0]! + 1, "decision-section", `**${s}:** is out of order`);
      last = at[0]!;
    }
    decisions.push({ n, file, title: hm[2]!, date, status: value, targets });
  }

  // Numbering: unique and contiguous from 1. Duplicates are what parallel branches produce.
  const byN = new Map<number, Decision[]>();
  for (const d of decisions) byN.set(d.n, [...(byN.get(d.n) ?? []), d]);
  for (const [n, ds] of byN) if (ds.length > 1) for (const d of ds) fail(d.file, 1, "decision-number", `D${pad(n, opts.pad)} is used by ${ds.length} files`);
  const max = Math.max(0, ...byN.keys());
  for (let n = 1; n <= max; n++) if (!byN.has(n)) fail(opts.dir, 0, "decision-number", `missing D${pad(n, opts.pad)}`);
  // Status targets exist and are later decisions.
  for (const d of decisions) {
    for (const t of d.targets) {
      if (!byN.has(t)) fail(d.file, 0, "decision-status", `D${pad(t, opts.pad)} doesn't exist`);
      else if (t <= d.n) fail(d.file, 0, "decision-status", `D${pad(t, opts.pad)} isn't later than D${pad(d.n, opts.pad)}`);
    }
  }
  decisions.sort((a, b) => a.n - b.n);
  return { decisions, failures };
}

export const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** The generated index, docs/decisions/README.md. */
export function renderIndex(decisions: Decision[], opts: DecisionOptions = DEFAULT_DECISIONS, command = "docs-check --write-index"): string {
  const counts = new Map<string, number>();
  for (const d of decisions) {
    const k = d.status.split(" ")[0]!.toLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const summary = [...counts].map(([k, v]) => `${v} ${k}`).join(", ");
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  return [
    "# Decisions",
    "",
    `Generated by \`${command}\`; don't edit by hand. One file per decision.`,
    "",
    `${decisions.length} decisions${summary ? `: ${summary}` : ""}.`,
    "",
    "| # | Decision | Date | Status |",
    "|---|---|---|---|",
    ...decisions.map((d) => {
      const rel = d.file.slice(opts.dir.length + 1);
      return `| [D${pad(d.n, opts.pad)}](${rel}) | ${esc(d.title)} | ${d.date} | ${esc(d.status)} |`;
    }),
    "",
  ].join("\n");
}
