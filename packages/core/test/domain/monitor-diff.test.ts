import { describe, expect, it } from "vitest";

import { asId } from "../../src/domain/ids.js";
import { computeMonitorDiff, DEFAULT_MONITOR_THRESHOLDS } from "../../src/domain/monitor-diff.js";
import type { EvidenceItem, Opportunity } from "../../src/domain/types.js";

function opportunity(
  id: string,
  clusterId: string,
  evidenceCount: number,
  confidence: Opportunity["confidence"] = "medium",
  status: Opportunity["status"] = "hypothesis",
): Opportunity {
  return {
    id: asId(id),
    clusterId: asId(clusterId),
    status,
    demandStatement: `Demand ${clusterId}`,
    persona: "user",
    scenario: "test",
    evidenceItemIds: Array.from({ length: evidenceCount }, (_, i) => asId(`e_${id}_${i}`)),
    disconfirmingEvidenceItemIds: [],
    pseudoDemandRisks: [],
    scoreVector: {
      frequency: 0.5,
      crossSource: 0.5,
      recency: 0.5,
      wtpStrength: 0.5,
      workaroundDepth: 0.5,
    },
    confidence,
    confidenceReasons: [],
    provenance: { createdBy: "pipeline", promotedBy: null },
  };
}

describe("monitor diff", () => {
  it("classifies added, heated, cooled, and unchanged clusters", () => {
    const baselineRunId = asId("run_a");
    const compareRunId = asId("run_b");

    const diff = computeMonitorDiff({
      baselineRunId,
      compareRunId,
      baselineOpportunities: [
        opportunity("opp_a", "cluster_stable", 3, "medium"),
        opportunity("opp_b", "cluster_heated", 3, "low"),
        opportunity("opp_c", "cluster_gone", 4, "medium"),
      ],
      compareOpportunities: [
        opportunity("opp_a2", "cluster_stable", 3, "medium"),
        opportunity("opp_b2", "cluster_heated", 5, "high", "promoted"),
        opportunity("opp_d", "cluster_new", 3, "medium"),
      ],
    });

    const byCluster = new Map(diff.entries.map((e) => [String(e.clusterId), e.kind]));
    expect(byCluster.get("cluster_new")).toBe("added");
    expect(byCluster.get("cluster_heated")).toBe("heated");
    expect(byCluster.get("cluster_gone")).toBe("cooled");
    expect(byCluster.get("cluster_stable")).toBe("unchanged");
    expect(diff.summary.added).toBe(1);
    expect(diff.summary.heated).toBe(1);
    expect(diff.summary.cooled).toBe(1);
    expect(diff.summary.unchanged).toBe(1);
    expect(diff.entries.find((entry) => entry.kind === "cooled")?.notificationReasons).toContain("material_cooling");
  });

  it("suppresses cooling when compare source coverage is incomplete", () => {
    const diff = computeMonitorDiff({
      baselineRunId: asId("run_complete"), compareRunId: asId("run_partial"),
      baselineOpportunities: [opportunity("opp_before", "cluster_same", 3)], compareOpportunities: [],
      compareCoverage: { complete: false, incompleteRequestKeys: ["quant:google:0"], sources: [{ requestKey: "quant:google:0", source: "google_trends", status: "throttled", reason: "429", itemCount: 0 }] },
    });
    expect(diff.coverage.partial).toBe(true);
    expect(diff.summary.cooled).toBe(0);
    expect(diff.entries[0]).toMatchObject({ kind: "unchanged", conclusive: false, coolingSuppressed: true, causes: expect.arrayContaining(["source_coverage_incomplete"]) });
  });

  it("matches run-scoped cluster IDs by their stable cluster role", () => {
    const baselineRunId = asId("run_stable_a"); const compareRunId = asId("run_stable_b");
    const baseline = { ...opportunity("opp_stable_a", `cluster_${baselineRunId}_pain`, 2), demandStatement: "Demand around invoice automation (pain)", persona: "invoice operators" };
    const compare = { ...opportunity("opp_stable_b", `cluster_${compareRunId}_pain`, 3), demandStatement: "Demand around invoice automation (pain)", persona: "invoice operators", scenario: "changed evidence count" };
    const diff = computeMonitorDiff({
      baselineRunId, compareRunId,
      baselineOpportunities: [baseline], compareOpportunities: [compare],
    });
    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0]?.kind).toBe("heated");
  });

  it("does not collapse different demand semantics that share a cluster role", () => {
    const baselineRunId = asId("run_semantic_a"); const compareRunId = asId("run_semantic_b");
    const before = { ...opportunity("opp_semantic_a", `cluster_${baselineRunId}_pain`, 2), demandStatement: "Demand around invoice automation (pain)", persona: "operators" };
    const after = { ...opportunity("opp_semantic_b", `cluster_${compareRunId}_pain`, 2), demandStatement: "Demand around travel booking (pain)", persona: "operators" };
    const diff = computeMonitorDiff({ baselineRunId, compareRunId, baselineOpportunities: [before], compareOpportunities: [after] });
    expect(diff.summary).toMatchObject({ added: 1, cooled: 1 });
  });

  it("reports evidence causes and threshold notification reasons", () => {
    const before = opportunity("opp_threshold_before", "cluster_threshold", 1);
    const after = opportunity("opp_threshold_after", "cluster_threshold", 3);
    const evidence = (id: string, platform: string, supportsClaim: EvidenceItem["supportsClaim"]): EvidenceItem => ({
      id: asId(id), clusterId: asId("cluster_threshold"), opportunityId: null, rawSignalId: asId(`signal_${id}`), documentId: asId(`doc_${id}`), chunkId: asId(`chunk_${id}`),
      platform, url: `https://example.test/${id}`, linkStatus: "ok", quoteVerbatim: id, supportsClaim, strength: supportsClaim === "pain" ? "supporting" : "primary", userVerified: true, provenance: { createdBy: "pipeline", agentRunId: null }, fetchedAt: "2026-07-11T00:00:00.000Z",
    });
    const baselineEvidence = new Map([[before.evidenceItemIds[0]!, evidence(String(before.evidenceItemIds[0]), "hn", "pain")]]);
    const compareEvidence = new Map([
      [after.evidenceItemIds[0]!, evidence(String(after.evidenceItemIds[0]), "hn", "pain")],
      [after.evidenceItemIds[1]!, evidence(String(after.evidenceItemIds[1]), "stack_exchange", "pain")],
      [after.evidenceItemIds[2]!, evidence(String(after.evidenceItemIds[2]), "manual", "wtp")],
    ]);
    const diff = computeMonitorDiff({ baselineRunId: asId("run_threshold_a"), compareRunId: asId("run_threshold_b"), baselineOpportunities: [before], compareOpportunities: [after], baselineEvidence, compareEvidence });
    expect(diff.entries[0]).toMatchObject({ kind: "heated", evidenceChange: { sourceCountDelta: 2, strongPainDelta: 1, commercialEvidenceDelta: 1 }, notificationReasons: expect.arrayContaining(["cross_source_growth", "strong_pain_growth", "commercial_evidence_growth"]) });
    expect(diff.notifications.triggered).toBe(true);
  });

  it("rejects zero thresholds instead of notifying unchanged entries", () => {
    expect(() => computeMonitorDiff({ baselineRunId: asId("run_zero_a"), compareRunId: asId("run_zero_b"), baselineOpportunities: [], compareOpportunities: [], thresholds: { ...DEFAULT_MONITOR_THRESHOLDS, minStrongPainGrowth: 0 } })).toThrow("positive integers");
  });
});
