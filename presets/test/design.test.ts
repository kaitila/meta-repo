// The preset starts from design-kit's default tokens; an app made from it then owns its
// copy and re-skins by editing it (D0017).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repo = join(import.meta.dir, "..", "..");

test("the preset's tokens.css and tokens.ts are design-kit's defaults", () => {
  for (const f of ["tokens.css", "tokens.ts"]) {
    expect(readFileSync(join(repo, "presets/bun-ts-postgres/src/ui", f), "utf8"), `${f}: copy packages/design-kit/${f} into presets/bun-ts-postgres/src/ui/`).toBe(
      readFileSync(join(repo, "packages/design-kit", f), "utf8"),
    );
  }
});
