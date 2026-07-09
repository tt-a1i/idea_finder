import { describe, expect, it } from "vitest";

import { createPolicyEngine, type AgentConnector } from "./index.js";

describe("@idea-finder/agents", () => {
  it("defines AgentConnector port shape", () => {
    const connector = { kind: "research", name: "stub" } as AgentConnector;
    expect(connector.kind).toBe("research");
  });

  it("exports PolicyEngine factory", () => {
    const engine = createPolicyEngine();
    expect(engine.evaluate).toBeTypeOf("function");
  });
});
