import { describe, expect, it } from "vitest";

import { asId } from "../../src/domain/ids.js";
import { computeMonitorDiff } from "../../src/domain/monitor-diff.js";
import type { Opportunity } from "../../src/domain/types.js";

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
  });
});
