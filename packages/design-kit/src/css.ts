// A small CSS reader: enough structure for tokens, the lint and the style resolver.
// Not a full parser: it knows blocks, declarations, comments and strings, which is
// all a hand-written stylesheet of rules, @media and custom properties needs.

export interface Decl {
  prop: string;
  value: string;
  line: number;
}

export interface Block {
  /** The selector or at-rule before `{`, e.g. `:root` or `@media (prefers-color-scheme: dark)`. */
  prelude: string;
  line: number;
  decls: Decl[];
  children: Block[];
}

/** Replace comments with spaces, keeping newlines so line numbers still match. */
export function stripComments(text: string, opts: { lineComments?: boolean } = {}): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const c = text[i]!;
    if (quote) {
      out += c;
      if (c === "\\" && i + 1 < text.length) {
        out += text[++i];
      } else if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || (opts.lineComments && c === "`")) {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    // `//` starts a comment in JS/TS, but not in `https://` (a word character or `:` before it).
    if (opts.lineComments && c === "/" && text[i + 1] === "/" && !/[\w:]/.test(text[i - 1] ?? "")) {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** The stylesheet's top-level blocks. Throws on unbalanced braces. */
export function parseCss(source: string): Block[] {
  const text = stripComments(source);
  const root: Block = { prelude: "", line: 1, decls: [], children: [] };
  const stack: Block[] = [root];
  let buf = "";
  let bufLine = 1;
  let line = 1;
  let quote: string | null = null;
  let parens = 0;

  const flushDecl = () => {
    const t = buf.trim();
    buf = "";
    if (!t) return;
    const colon = t.indexOf(":");
    const top = stack[stack.length - 1]!;
    if (colon <= 0 || top === root) return; // a stray statement such as `@import x;` at the top level
    top.decls.push({ prop: t.slice(0, colon).trim(), value: t.slice(colon + 1).trim(), line: bufLine });
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (!buf.trim() && !/\s/.test(c)) bufLine = line;
    if (c === "\n") line++;
    if (quote) {
      buf += c;
      if (c === "\\") buf += text[++i] ?? "";
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      continue;
    }
    if (c === "(") parens++;
    if (c === ")") parens = Math.max(0, parens - 1);
    if (parens > 0) {
      buf += c;
      continue;
    }
    if (c === "{") {
      const block: Block = { prelude: buf.trim().replace(/\s+/g, " "), line: bufLine, decls: [], children: [] };
      stack[stack.length - 1]!.children.push(block);
      stack.push(block);
      buf = "";
    } else if (c === "}") {
      flushDecl();
      if (stack.length === 1) throw new Error(`unexpected "}" on line ${line}`);
      stack.pop();
    } else if (c === ";") {
      flushDecl();
    } else buf += c;
  }
  if (stack.length > 1) throw new Error(`unclosed "{" from line ${stack[stack.length - 1]!.line}`);
  return root.children;
}
