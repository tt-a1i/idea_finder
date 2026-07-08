import { describe, expect, it } from "vitest";

import type { LLMProvider } from "./index.js";

describe("@idea-finder/llm", () => {
  it("defines LLMProvider port shape", () => {
    const provider = { name: "fake" } as LLMProvider;
    expect(provider.name).toBe("fake");
  });
});
