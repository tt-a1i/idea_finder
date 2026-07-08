import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@idea-finder/core": path.join(rootDir, "packages/core/src/index.ts"),
      "@idea-finder/storage": path.join(rootDir, "packages/storage/src/index.ts"),
      "@idea-finder/llm": path.join(rootDir, "packages/llm/src/index.ts"),
      "@idea-finder/agents": path.join(rootDir, "packages/agents/src/index.ts"),
      "@idea-finder/connectors": path.join(rootDir, "packages/connectors/src/index.ts"),
      "@idea-finder/harvest": path.join(rootDir, "packages/harvest/src/index.ts"),
      "@idea-finder/intelligence": path.join(rootDir, "packages/intelligence/src/index.ts"),
      "@idea-finder/orchestration": path.join(rootDir, "packages/orchestration/src/index.ts"),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "packages/**/*.spec.ts"],
    environment: "node",
  },
});
