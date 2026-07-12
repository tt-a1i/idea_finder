import { describe, expect, it } from "vitest";
import { buildProposedSearchPlan } from "../src/orchestration/search-plan.js";
import {
  clusterPainSignals,
  evaluateStopCondition,
  generateFollowUpQueries,
} from "../src/orchestration/research-rounds.js";

describe("multi-round research saturation", () => {
  it("clusters pain signals and generates follow-ups with trigger evidence", () => {
    const independence = new Map([
      ["doc_a", "g1"],
      ["doc_b", "g2"],
    ]);
    const clusters = clusterPainSignals({
      signals: [
        { id: "s1", signalType: "pain", quoteVerbatim: "painful Monday handoff", documentId: "doc_a" },
        { id: "s2", signalType: "workaround", quoteVerbatim: "manual spreadsheet", documentId: "doc_b" },
      ],
      independenceGroupByDocumentId: independence,
    });
    expect(clusters.length).toBeGreaterThanOrEqual(2);
    const plan = buildProposedSearchPlan({ topic: "agent coding" });
    const followUps = generateFollowUpQueries({
      plan,
      round: 2,
      clusters,
      existingQueryTexts: new Set(),
    });
    expect(followUps.length).toBeGreaterThan(0);
    expect(followUps.every((query) => query.round === 2)).toBe(true);
    expect(followUps.some((query) => query.triggerEvidenceId)).toBe(true);
  });

  it("stops for budget and saturated conditions without claiming full saturation on partial coverage", () => {
    expect(evaluateStopCondition({
      rounds: [{ round: 1, queryIds: ["q1"], newDocumentCount: 1, newEvidenceCount: 1, newClusterCount: 1, coverageIncomplete: false }],
      budgets: { queries: 1, documents: 100, rounds: 3 },
      executedQueryCount: 1,
      documentCount: 1,
      coverageIncomplete: false,
    })).toBe("budget_exhausted");

    expect(evaluateStopCondition({
      rounds: [
        { round: 1, queryIds: ["q1"], newDocumentCount: 1, newEvidenceCount: 1, newClusterCount: 0, coverageIncomplete: true },
        { round: 2, queryIds: ["q2"], newDocumentCount: 0, newEvidenceCount: 0, newClusterCount: 0, coverageIncomplete: true },
      ],
      budgets: { queries: 100, documents: 100, rounds: 5 },
      executedQueryCount: 2,
      documentCount: 1,
      coverageIncomplete: true,
    })).toBe("budget_exhausted_partial");

    expect(evaluateStopCondition({
      rounds: [
        { round: 1, queryIds: ["q1"], newDocumentCount: 1, newEvidenceCount: 1, newClusterCount: 0, coverageIncomplete: false },
        { round: 2, queryIds: ["q2"], newDocumentCount: 0, newEvidenceCount: 0, newClusterCount: 0, coverageIncomplete: false },
      ],
      budgets: { queries: 100, documents: 100, rounds: 5 },
      executedQueryCount: 2,
      documentCount: 1,
      coverageIncomplete: false,
    })).toBe("saturated");
  });
});
