import { describe, expect, it } from "vitest";
import { buildBroadQueryVariants, countDistinctLenses, coverageStats } from "../src/orchestration/broad-search-plan.js";
import { buildProposedSearchPlan } from "../src/orchestration/search-plan.js";
import { resolveQueryTexts } from "@idea-finder/connectors";
import { buildQueryPlanFromBrief } from "../src/orchestration/query-plan-builder.js";
import { asId } from "@idea-finder/core";
import type { HuntingBrief } from "../src/types.js";

describe("broad query variants", () => {
  it("generates at least 30 deduped queries covering at least 6 lenses", () => {
    const plan = buildProposedSearchPlan({
      topic: "agent coding workflows",
      languages: ["en", "zh"],
      sourceFamilies: ["hn", "stack_exchange"],
    });
    const queries = buildBroadQueryVariants(plan);
    expect(queries.length).toBeGreaterThanOrEqual(30);
    expect(countDistinctLenses(queries)).toBeGreaterThanOrEqual(6);
    expect(new Set(queries.map((query) => query.id)).size).toBe(queries.length);
    expect(queries.every((query) => query.language === "en" || query.language === "zh")).toBe(true);
    expect(queries.every((query) => query.status === "pending")).toBe(true);
    const stats = coverageStats(queries);
    expect(stats.languages).toBeGreaterThanOrEqual(2);
    expect(stats.sources).toBeGreaterThanOrEqual(2);
  });

  it("does not join all terms into one connector query string", () => {
    expect(resolveQueryTexts({ terms: ["agent coding", "workaround"] })).toEqual([
      "agent coding",
      "workaround",
    ]);
    expect(resolveQueryTexts({ terms: ["a", "b"], queryText: "exact query" })).toEqual(["exact query"]);
  });

  it("expands multi-term brief searches into independent query variants", () => {
    const brief: HuntingBrief = {
      id: asId("task_x"),
      slug: "x",
      title: "x",
      description: "d",
      lenses: ["pain"],
      sourcesEnabled: ["hn"],
      successCriteria: "s",
      createdAt: "2026-07-11T00:00:00.000Z",
      queryPlan: {
        harvestMode: "l0",
        searches: [{ platform: "hn", terms: ["agent coding", "workaround"] }],
      },
    };
    const plan = buildQueryPlanFromBrief(brief, brief.id);
    expect(plan.searches).toHaveLength(4);
    expect(plan.searches.map((search) => search.queryText)).toEqual([
      "agent coding",
      "agent coding",
      "workaround",
      "workaround",
    ]);
    expect(plan.searches.every((search) => search.terms.length === 1)).toBe(true);
    expect(plan.searches.filter((search) => search.hnTags === "comment")).toHaveLength(2);
  });

  it("manual harvest mode keeps SearchPlan network queries out of the QueryPlan", () => {
    const brief: HuntingBrief = {
      id: asId("task_manual_only"),
      slug: "manual-only",
      title: "Manual only",
      description: "imports only",
      lenses: ["pain"],
      sourcesEnabled: ["manual"],
      successCriteria: "s",
      createdAt: "2026-07-11T00:00:00.000Z",
      searchPlanId: "plan_test",
      searchPlanVersion: 1,
      queryPlan: {
        harvestMode: "manual",
        manualImports: [{ text: "Standup notes get lost between coding agents every Monday." }],
      },
    };
    const plan = buildQueryPlanFromBrief(brief, brief.id, [
      { id: "q1", queryText: "agent handoff pain", source: "hn" },
      { id: "q2", queryText: "standup workaround", source: "v2ex" },
    ]);
    expect(plan.searches).toEqual([]);
    expect(plan.manualImports).toEqual([
      { text: "Standup notes get lost between coding agents every Monday." },
    ]);
  });
});
