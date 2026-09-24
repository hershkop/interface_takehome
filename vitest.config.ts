import { defineConfig } from "vitest/config";

export default defineConfig({
  // Only this project's own tests. Keeps stray working-tree copies (e.g. a local review
  // checkout) from being collected.
  test: { include: ["test/**/*.test.ts"] },
});
