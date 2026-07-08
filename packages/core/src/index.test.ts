import { describe, expect, it } from "vitest";

import { asId, type HuntingTaskId } from "./index.js";

describe("@idea-finder/core", () => {
  it("exports branded id helpers", () => {
    const id = asId<HuntingTaskId>("task_1");
    expect(id).toBe("task_1");
  });
});
