// What a stylesheet's declarations come to once its var() references are filled in from
// the tokens: the values a browser would compute for them, without a browser. Tests use it
// to show that editing the tokens file alone re-skins a page.
import { type Block, parseCss } from "./css";
import type { Tokens } from "./tokens";

export interface ResolvedDecl {
  /** `@media (…) > selector`, or just the selector. */
  where: string;
  prop: string;
  /** The value as written, e.g. `var(--color-ink)`. */
  raw: string;
  /** The value with every var() replaced, e.g. `#1d1c1a`. */
  value: string;
  /** Token names the value reads, directly or through other tokens. */
  uses: string[];
}

/** Replace var(--x[, fallback]) with values from `env`, recursively. Unknown names keep their fallback, or stay as `var(--x)`. */
export function substitute(value: string, env: Record<string, string>, uses: Set<string> = new Set(), depth = 0): string {
  if (depth > 20) throw new Error(`var() nesting too deep (a cycle?) in "${value}"`);
  let out = "";
  let i = 0;
  while (i < value.length) {
    const at = value.indexOf("var(", i);
    if (at === -1) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, at);
    let j = at + 4;
    let depthParen = 1;
    while (j < value.length && depthParen) {
      if (value[j] === "(") depthParen++;
      else if (value[j] === ")") depthParen--;
      j++;
    }
    const inner = value.slice(at + 4, j - 1);
    const comma = inner.indexOf(",");
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim().replace(/^--/, "");
    const fallback = comma === -1 ? undefined : inner.slice(comma + 1).trim();
    if (name in env) {
      uses.add(name);
      out += substitute(env[name]!, env, uses, depth + 1);
    } else out += fallback !== undefined ? substitute(fallback, env, uses, depth + 1) : `var(--${name})`;
    i = j;
  }
  return out;
}

/** Every declaration in `css`, resolved against the tokens in one scheme. Custom properties a rule defines apply to its own declarations. */
export function resolveStyles(css: string, tokens: Tokens, scheme: "light" | "dark" = "light"): ResolvedDecl[] {
  const out: ResolvedDecl[] = [];
  const walk = (blocks: Block[], media: string) => {
    for (const b of blocks) {
      if (b.prelude.startsWith("@")) {
        walk(b.children, media ? `${media} ${b.prelude}` : b.prelude);
        continue;
      }
      const env: Record<string, string> = { ...tokens[scheme] };
      for (const d of b.decls) if (d.prop.startsWith("--")) env[d.prop.slice(2)] = d.value;
      for (const d of b.decls) {
        const uses = new Set<string>();
        const value = substitute(d.value, env, uses);
        out.push({ where: media ? `${media} > ${b.prelude}` : b.prelude, prop: d.prop, raw: d.value, value, uses: [...uses].filter((u) => u in tokens.light) });
      }
      walk(b.children, media);
    }
  };
  walk(parseCss(css), "");
  return out;
}
