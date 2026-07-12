import { describe, expect, it } from "vitest";

import { createL0ConnectorPack, type SourceConnector } from "./index.js";

describe("@idea-finder/connectors", () => {
  it("defines SourceConnector port shape", () => {
    const connector = { platform: "hn" } as SourceConnector;
    expect(connector.platform).toBe("hn");
  });

  it("exports L0 default connector pack", () => {
    const pack = createL0ConnectorPack();
    expect(pack.length).toBe(6);
  });
});
