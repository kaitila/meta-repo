// Markdown helpers: which lines are prose (not inside fenced code), inline code spans,
// links, and GitHub-style heading anchors.

/** Each line, with lines inside fenced code blocks blanked (line numbers are kept). */
export function proseLines(md: string): string[] {
  const out: string[] = [];
  let fence: { char: string; len: number } | null = null;
  for (const line of md.split("\n")) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      // A fence closes on the same character, at least as long, with nothing after it.
      if (m && m[1]![0] === fence.char && m[1]!.length >= fence.len && line.trim() === m[1]) fence = null;
      out.push("");
      continue;
    }
    if (m) {
      fence = { char: m[1]![0]!, len: m[1]!.length };
      out.push("");
      continue;
    }
    out.push(line);
  }
  return out;
}

/** Inline code spans on a line (`x`, ``x``). */
export function codeSpans(line: string): string[] {
  const out: string[] = [];
  const re = /(`+)([^`]+?)\1(?!`)/g;
  for (let m; (m = re.exec(line)); ) out.push(m[2]!.trim());
  return out;
}

/** The line with inline code spans replaced by spaces (so links inside code aren't links). */
export function withoutCode(line: string): string {
  return line.replace(/(`+)([^`]+?)\1(?!`)/g, (s) => " ".repeat(s.length));
}

/** Inline links and images: [text](target "title"). Targets with ")" inside <> are handled. */
export function links(line: string): string[] {
  const out: string[] = [];
  const re = /!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(?:\s+"[^"]*")?\s*\)/g;
  for (let m; (m = re.exec(line)); ) out.push(m[1]!.replace(/^<|>$/g, ""));
  return out;
}

/** GitHub's heading anchor: lowercase, drop punctuation except - and _, spaces to -. */
export function slug(heading: string): string {
  return heading
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Every anchor a file offers: one per heading (duplicates get -1, -2, ...). */
export function anchors(md: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const line of proseLines(md)) {
    const m = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = slug(m[1]!);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}
