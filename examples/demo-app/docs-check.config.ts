import { defineConfig, envRegistry } from "@meta-repo/docs-check";

export default defineConfig({
  registries: [envRegistry({ doc: "docs/configuration.md" })],
});
