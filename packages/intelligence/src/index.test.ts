import { describe, expect, it } from "vitest";

import { createIntelligencePipeline } from "./index.js";

describe("@idea-finder/intelligence", () => {
  it("creates a no-op intelligence pipeline scaffold", async () => {
    const pipeline = createIntelligencePipeline({
      llm: { name: "fake", complete: async () => ({ text: "", usage: { promptTokens: 0, completionTokens: 0 }, provider: "fake", model: "fake" }) },
    });
    await expect(pipeline.run("run_1" as never)).resolves.toBeUndefined();
  });
});
