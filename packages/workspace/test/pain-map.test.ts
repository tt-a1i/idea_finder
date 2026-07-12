import { describe, expect, it } from "vitest";
import { buildProposedSearchPlan, confirmSearchPlanEntity } from "../src/orchestration/search-plan.js";
import { buildBroadQueryVariants } from "../src/orchestration/broad-search-plan.js";
import { buildPainMapReport, renderPainMapMarkdown } from "../src/report/pain-map.js";

describe("pain map report", () => {
  it("renders coverage stats and weak single-source clusters with evidence links", () => {
    const proposed = buildProposedSearchPlan({ topic: "agent coding workflows", languages: ["en", "zh"] });
    const plan = confirmSearchPlanEntity({ ...proposed, queries: buildBroadQueryVariants(proposed) }, { mode: "start_now" });
    const report = buildPainMapReport({
      plan,
      clusters: [{
        id: "cluster_pain_1",
        painStatement: "Monday handoffs are painful",
        signalTypes: ["pain"],
        documentIds: ["doc1"],
        evidenceIds: ["ev1"],
        independentSourceCount: 1,
        languages: ["en"],
      }],
      rounds: [{ round: 1, queryIds: plan.queries.slice(0, 2).map((query) => query.id), newDocumentCount: 1, newEvidenceCount: 1, newClusterCount: 1, coverageIncomplete: true }],
      stopReason: "budget_exhausted_partial",
      documentCount: 1,
      evidenceCount: 1,
      dedupeCount: 0,
      incompleteSources: ["google_trends"],
      evidenceSnippets: [{ clusterId: "cluster_pain_1", quote: "Monday handoffs are painful", url: "https://example.com/1", evidenceId: "ev1", signalType: "pain" }],
    });
    expect(report.schemaVersion).toBe("pain_map_v1");
    expect(report.stats.queryCount).toBeGreaterThanOrEqual(30);
    expect(report.clusters[0]?.strength).toBe("weak/single-source");
    const markdown = renderPainMapMarkdown(report);
    expect(markdown).toContain("Pain map:");
    expect(markdown).toContain("Stop reason: budget_exhausted_partial");
    expect(markdown).toContain("https://example.com/1");
    expect(markdown).toContain("## Facts");
    expect(markdown).toContain("## Inference");
    expect(markdown).toContain("## Unresolved uncertainty");
  });
});
