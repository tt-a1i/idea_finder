import { describe, expect, it } from "vitest";
import { buildProposedSearchPlan } from "../src/orchestration/search-plan.js";
import {
  clusterPainSignals,
  countNewClusters,
  evaluateStopCondition,
  generateFollowUpQueries,
  type PainClusterSeed,
} from "../src/orchestration/research-rounds.js";

describe("cluster identity inheritance", () => {
  it("assigns unique ids when a previous cluster splits into two groups", () => {
    const previous: PainClusterSeed[] = [{
      id: "cluster_old",
      painStatement: "prior pain",
      signalTypes: ["pain"],
      documentIds: ["doc_a", "doc_b"],
      evidenceIds: ["e1", "e2"],
      independentSourceCount: 2,
      languages: ["en"],
    }];
    const independence = new Map([["doc_a", "g1"], ["doc_b", "g2"]]);
    const clusters = clusterPainSignals({
      signals: [
        { id: "e1", signalType: "pain", quoteVerbatim: "deploy logs spreadsheet manual paste weekly", documentId: "doc_a" },
        { id: "e2", signalType: "pain", quoteVerbatim: "monday standup notes lost between coding agents", documentId: "doc_b" },
      ],
      independenceGroupByDocumentId: independence,
      similarityThreshold: 0.99,
      previousClusters: previous,
    });
    expect(clusters).toHaveLength(2);
    expect(new Set(clusters.map((cluster) => cluster.id)).size).toBe(2);
    expect(clusters.some((cluster) => cluster.id === "cluster_old")).toBe(true);
    expect(countNewClusters(new Set(["cluster_old"]), clusters)).toBe(1);
  });

  it("inherits one previous id when two prior clusters merge", () => {
    const previous: PainClusterSeed[] = [
      {
        id: "cluster_a",
        painStatement: "handoff pain",
        signalTypes: ["pain"],
        documentIds: ["doc_a"],
        evidenceIds: ["e1"],
        independentSourceCount: 1,
        languages: ["en"],
      },
      {
        id: "cluster_b",
        painStatement: "handoff pain weekly",
        signalTypes: ["pain"],
        documentIds: ["doc_b"],
        evidenceIds: ["e2"],
        independentSourceCount: 1,
        languages: ["en"],
      },
    ];
    const independence = new Map([["doc_a", "g1"], ["doc_b", "g1"]]);
    const clusters = clusterPainSignals({
      signals: [
        { id: "e1", signalType: "pain", quoteVerbatim: "painful handoff workflow", documentId: "doc_a" },
        { id: "e2", signalType: "pain", quoteVerbatim: "painful handoff workflow every week", documentId: "doc_b" },
      ],
      independenceGroupByDocumentId: independence,
      previousClusters: previous,
    });
    expect(clusters).toHaveLength(1);
    expect(["cluster_a", "cluster_b"]).toContain(clusters[0]?.id);
    expect(countNewClusters(new Set(["cluster_a", "cluster_b"]), clusters)).toBe(0);
  });

  it("reaches saturated stop reason after two zero-new-cluster rounds with budget headroom", () => {
    const stopReason = evaluateStopCondition({
      rounds: [
        { round: 1, queryIds: ["q1"], newDocumentCount: 1, newEvidenceCount: 1, newClusterCount: 0, coverageIncomplete: false },
        { round: 2, queryIds: ["q2"], newDocumentCount: 0, newEvidenceCount: 0, newClusterCount: 0, coverageIncomplete: false },
      ],
      budgets: { queries: 100, documents: 100, rounds: 10 },
      executedQueryCount: 2,
      documentCount: 1,
      coverageIncomplete: false,
    });
    expect(stopReason).toBe("saturated");
  });

  it("maximizes inherited identities for adversarial overlap (not greedy single claim)", () => {
    const previous: PainClusterSeed[] = [
      {
        id: "cluster_p1",
        painStatement: "mixed prior",
        signalTypes: ["pain"],
        documentIds: ["doc_a", "doc_c"],
        evidenceIds: ["a", "c"],
        independentSourceCount: 2,
        languages: ["en"],
      },
      {
        id: "cluster_p2",
        painStatement: "handoff prior",
        signalTypes: ["pain"],
        documentIds: ["doc_b"],
        evidenceIds: ["b"],
        independentSourceCount: 1,
        languages: ["en"],
      },
    ];
    const independence = new Map([
      ["doc_a", "g1"],
      ["doc_b", "g1"],
      ["doc_new", "g1"],
      ["doc_c", "g2"],
    ]);
    const signals = [
      { id: "a", signalType: "pain" as const, quoteVerbatim: "painful handoff workflow", documentId: "doc_a" },
      { id: "b", signalType: "pain" as const, quoteVerbatim: "painful handoff workflow every week", documentId: "doc_b" },
      { id: "new", signalType: "pain" as const, quoteVerbatim: "painful handoff workflow between agents", documentId: "doc_new" },
      { id: "c", signalType: "pain" as const, quoteVerbatim: "deploy logs spreadsheet manual paste weekly", documentId: "doc_c" },
    ];
    const clusters = clusterPainSignals({
      signals,
      independenceGroupByDocumentId: independence,
      previousClusters: previous,
    });
    expect(clusters).toHaveLength(2);
    expect(clusters.map((cluster) => cluster.id).sort()).toEqual(["cluster_p1", "cluster_p2"]);
    expect(countNewClusters(new Set(["cluster_p1", "cluster_p2"]), clusters)).toBe(0);

    const reversed = clusterPainSignals({
      signals,
      independenceGroupByDocumentId: independence,
      previousClusters: [...previous].reverse(),
    });
    expect(reversed.map((cluster) => cluster.id).sort()).toEqual(clusters.map((cluster) => cluster.id).sort());
    for (const cluster of clusters) {
      const match = reversed.find((item) => item.id === cluster.id);
      expect(match?.evidenceIds.sort()).toEqual([...cluster.evidenceIds].sort());
    }

    const newClusterCount = countNewClusters(new Set(["cluster_p1", "cluster_p2"]), clusters);
    expect(evaluateStopCondition({
      rounds: [
        { round: 1, queryIds: ["q1"], newDocumentCount: 1, newEvidenceCount: 1, newClusterCount: 0, coverageIncomplete: false },
        { round: 2, queryIds: ["q2"], newDocumentCount: 0, newEvidenceCount: 0, newClusterCount, coverageIncomplete: false },
      ],
      budgets: { queries: 100, documents: 100, rounds: 10 },
      executedQueryCount: 2,
      documentCount: 1,
      coverageIncomplete: false,
    })).toBe("saturated");
  });

  it("avoids fresh id collision with naturally generated inherited stable ids after split", () => {
    const independence = new Map([
      ["doc_a", "g1"],
      ["doc_b", "g2"],
    ]);
    const splitSignals = [
      { id: "e_a", signalType: "pain" as const, quoteVerbatim: "deploy logs spreadsheet manual paste weekly", documentId: "doc_a" },
      { id: "e_b", signalType: "pain" as const, quoteVerbatim: "monday standup notes lost between coding agents", documentId: "doc_b" },
    ];
    const natural = clusterPainSignals({
      signals: splitSignals,
      independenceGroupByDocumentId: independence,
      similarityThreshold: 0.99,
    });
    expect(natural).toHaveLength(2);
    const naturalByEvidence = new Map(
      natural.map((cluster) => [cluster.evidenceIds.slice().sort().join(","), cluster.id] as const),
    );
    const naturalIdB = naturalByEvidence.get("e_b");
    expect(naturalIdB).toBeTypeOf("string");

    // Prior id is the natural stable hash of the B split group; A inherits it after split.
    const previous: PainClusterSeed[] = [{
      id: naturalIdB!,
      painStatement: "prior merged pain",
      signalTypes: ["pain"],
      documentIds: ["doc_a", "doc_b"],
      evidenceIds: ["e_a", "e_b"],
      independentSourceCount: 2,
      languages: ["en"],
    }];

    const run = () => clusterPainSignals({
      signals: splitSignals,
      independenceGroupByDocumentId: independence,
      similarityThreshold: 0.99,
      previousClusters: previous,
    });
    const first = run();
    const second = run();
    expect(first).toHaveLength(2);
    expect(new Set(first.map((cluster) => cluster.id)).size).toBe(2);
    expect(first.some((cluster) => cluster.id === naturalIdB)).toBe(true);
    expect(first.find((cluster) => cluster.evidenceIds.includes("e_b"))?.id).not.toBe(naturalIdB);
    expect(first.map((cluster) => cluster.id).sort()).toEqual(second.map((cluster) => cluster.id).sort());
    for (const cluster of first) {
      const match = second.find((item) => item.id === cluster.id);
      expect(match?.evidenceIds.slice().sort()).toEqual(cluster.evidenceIds.slice().sort());
    }
  });

  it("matches dense dozens of overlapping clusters within a tight time budget", () => {
    const n = 36;
    const evidenceIds = Array.from({ length: n }, (_, i) => `e_${String(i).padStart(3, "0")}`);
    const previous: PainClusterSeed[] = Array.from({ length: n }, (_, i) => ({
      id: `cluster_p_${String(i).padStart(3, "0")}`,
      painStatement: `prior pain ${i}`,
      signalTypes: ["pain"],
      documentIds: evidenceIds.map((id) => `doc_${id}`),
      evidenceIds,
      independentSourceCount: n,
      languages: ["en"],
    }));
    const independence = new Map(evidenceIds.map((id) => [`doc_${id}`, `g_${id}`] as const));
    const signals = evidenceIds.map((id, i) => ({
      id,
      signalType: "pain" as const,
      quoteVerbatim: `unique pain token${i} xyzabc${i} workflow${i} checklist${i}`,
      documentId: `doc_${id}`,
    }));

    const started = Date.now();
    const clusters = clusterPainSignals({
      signals,
      independenceGroupByDocumentId: independence,
      similarityThreshold: 0.99,
      previousClusters: previous,
    });
    const elapsedMs = Date.now() - started;

    expect(elapsedMs).toBeLessThan(5_000);
    expect(clusters).toHaveLength(n);
    expect(new Set(clusters.map((cluster) => cluster.id)).size).toBe(n);
    expect(clusters.every((cluster) => cluster.id.startsWith("cluster_p_"))).toBe(true);
    expect(countNewClusters(new Set(previous.map((cluster) => cluster.id)), clusters)).toBe(0);

    const again = clusterPainSignals({
      signals,
      independenceGroupByDocumentId: independence,
      similarityThreshold: 0.99,
      previousClusters: [...previous].reverse(),
    });
    expect(again.map((cluster) => cluster.id).sort()).toEqual(clusters.map((cluster) => cluster.id).sort());
  });
});

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
