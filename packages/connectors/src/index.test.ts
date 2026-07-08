import { describe, expect, it } from "vitest";

import type { SourceConnector } from "./index.js";

describe("@idea-finder/connectors", () => {
  it("defines SourceConnector port shape", () => {
    const connector = { platform: "hn" } as SourceConnector;
    expect(connector.platform).toBe("hn");
  });
});
