import { describe, expect, it } from "vitest";
import { asId } from "@idea-finder/core";
import {
  buildQueryPlanFromBrief,
  effectiveResearchConfigHash,
} from "../src/orchestration/query-plan-builder.js";
import type { HuntingBrief } from "../src/types.js";

function brief(overrides: Partial<HuntingBrief> = {}): HuntingBrief {
  return {
    id: asId("task_lifecycle"),
    slug: "lifecycle",
    title: "Lifecycle",
    description: "Description is context, not imported evidence",
    lenses: ["pain"],
    sourcesEnabled: ["manual"],
    successCriteria: "explicit evidence only",
    createdAt: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}

describe("ResearchRun configuration", () => {
  it("does not synthesize manual imports or demonstration evidence", () => {
    expect(buildQueryPlanFromBrief(brief(), asId("task_lifecycle"))).toEqual({
      huntingTaskId: asId("task_lifecycle"),
      searches: [],
      manualImports: [],
    });
  });

  it("retains only explicitly supplied manual imports", () => {
    const configured = brief({
      queryPlan: {
        harvestMode: "manual",
        manualImports: [{ text: "Explicit interview note", url: "https://example.test/note" }],
      },
    });
    expect(buildQueryPlanFromBrief(configured, configured.id).manualImports).toEqual([
      { text: "Explicit interview note", url: "https://example.test/note" },
    ]);
  });

  it("hashes effective configuration stably and detects meaningful changes", () => {
    const original = brief();
    expect(effectiveResearchConfigHash(original)).toBe(effectiveResearchConfigHash({ ...original }));
    expect(effectiveResearchConfigHash(original)).not.toBe(
      effectiveResearchConfigHash({ ...original, lenses: ["pain", "wtp"] }),
    );
    expect(effectiveResearchConfigHash(original)).not.toBe(
      effectiveResearchConfigHash({ ...original, description: "Changed research context" }),
    );
  });
});
