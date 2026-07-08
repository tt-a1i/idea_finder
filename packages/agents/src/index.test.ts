import { describe, expect, it } from "vitest";

import type { AgentConnector } from "./index.js";

describe("@idea-finder/agents", () => {
  it("defines AgentConnector port shape", () => {
    const connector = { kind: "research", name: "stub" } as AgentConnector;
    expect(connector.kind).toBe("research");
  });
});
