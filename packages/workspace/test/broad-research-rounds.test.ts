import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asId } from "@idea-finder/core";
import type { SourceConnector } from "@idea-finder/connectors";
import { createHarvestPipeline } from "@idea-finder/harvest";
import { createIntelligencePipeline } from "@idea-finder/intelligence";
import { createStorageHarvestRepository } from "@idea-finder/orchestration";
import { openLocalStorage } from "@idea-finder/storage";
import { buildBroadQueryVariants, coverageStats } from "../src/orchestration/broad-search-plan.js";
import { runBroadResearchRounds } from "../src/orchestration/broad-research-rounds.js";
import {
  applyQueryExecutionWriteback,
  clusterPainSignals,
  countNewClusters,
  evaluateStopCondition,
  generateDivergenceQueries,
  generateFollowUpQueries,
} from "../src/orchestration/research-rounds.js";
import { buildProposedSearchPlan, confirmSearchPlanEntity } from "../src/orchestration/search-plan.js";
import { queryTermsFromBrief } from "../src/orchestration/query-plan-builder.js";
import type { HuntingBrief } from "../src/types.js";

describe("semantic pain clustering", () => {
  it("merges similar pain quotes and keeps distinct pains separate", () => {
    const independence = new Map([["doc_a", "g1"], ["doc_b", "g2"], ["doc_c", "g3"]]);
    const clusters = clusterPainSignals({
      signals: [
        { id: "s1", signalType: "pain", quoteVerbatim: "Monday standup notes get lost between coding agents", documentId: "doc_a" },
        { id: "s2", signalType: "pain", quoteVerbatim: "Standup notes lost every Monday between agents", documentId: "doc_b" },
        { id: "s3", signalType: "workaround", quoteVerbatim: "We paste deploy logs into a spreadsheet manually", documentId: "doc_c" },
      ],
      independenceGroupByDocumentId: independence,
    });
    expect(clusters).toHaveLength(2);
    expect(clusters.some((cluster) => cluster.signalTypes.includes("pain") && cluster.signalTypes.includes("workaround"))).toBe(false);
    expect(clusters.find((cluster) => cluster.signalTypes.includes("pain"))?.documentIds).toEqual(expect.arrayContaining(["doc_a", "doc_b"]));
  });

  it("uses stable cluster ids when similar signals arrive in later rounds", () => {
    const independence = new Map([["doc_a", "g1"], ["doc_b", "g1"]]);
    const round1 = clusterPainSignals({
      signals: [{ id: "s1", signalType: "pain", quoteVerbatim: "painful handoff workflow", documentId: "doc_a" }],
      independenceGroupByDocumentId: independence,
    });
    const round2 = clusterPainSignals({
      signals: [
        { id: "s1", signalType: "pain", quoteVerbatim: "painful handoff workflow", documentId: "doc_a" },
        { id: "s2", signalType: "pain", quoteVerbatim: "painful handoff workflow every week", documentId: "doc_b" },
      ],
      independenceGroupByDocumentId: independence,
      previousClusters: round1,
    });
    expect(countNewClusters(new Set(round1.map((cluster) => cluster.id)), round2)).toBe(0);
  });

  it("is order-stable for the same signal set", () => {
    const independence = new Map([["doc_a", "g1"], ["doc_b", "g2"], ["doc_c", "g3"]]);
    const signals = [
      { id: "s1", signalType: "pain", quoteVerbatim: "Monday standup notes get lost between coding agents", documentId: "doc_a" },
      { id: "s2", signalType: "pain", quoteVerbatim: "Standup notes lost every Monday between agents", documentId: "doc_b" },
      { id: "s3", signalType: "workaround", quoteVerbatim: "We paste deploy logs into a spreadsheet manually", documentId: "doc_c" },
    ];
    const forward = clusterPainSignals({ signals, independenceGroupByDocumentId: independence });
    const reverse = clusterPainSignals({ signals: [...signals].reverse(), independenceGroupByDocumentId: independence });
    expect(forward.map((cluster) => cluster.id).sort()).toEqual(reverse.map((cluster) => cluster.id).sort());
    expect(forward).toHaveLength(reverse.length);
    for (const cluster of forward) {
      const match = reverse.find((item) => item.id === cluster.id);
      expect(match?.evidenceIds.sort()).toEqual(cluster.evidenceIds.sort());
    }
  });

  it("keeps cluster identity when a lexicographically smaller similar signal joins", () => {
    const independence = new Map([["doc_a", "g1"], ["doc_b", "g1"]]);
    const initial = clusterPainSignals({
      signals: [{ id: "zzz_signal", signalType: "pain", quoteVerbatim: "painful handoff workflow", documentId: "doc_a" }],
      independenceGroupByDocumentId: independence,
    });
    const expanded = clusterPainSignals({
      signals: [
        { id: "aaa_signal", signalType: "pain", quoteVerbatim: "painful handoff workflow every week", documentId: "doc_b" },
        { id: "zzz_signal", signalType: "pain", quoteVerbatim: "painful handoff workflow", documentId: "doc_a" },
      ],
      independenceGroupByDocumentId: independence,
      previousClusters: initial,
    });
    expect(expanded).toHaveLength(1);
    expect(expanded[0]?.id).toBe(initial[0]?.id);
    expect(countNewClusters(new Set(initial.map((cluster) => cluster.id)), expanded)).toBe(0);
    expect(expanded[0]?.evidenceIds).toEqual(expect.arrayContaining(["aaa_signal", "zzz_signal"]));
    expect(expanded[0]?.documentIds).toEqual(expect.arrayContaining(["doc_a", "doc_b"]));
  });


  it("keeps cluster identity when a longer quote existed before a shorter similar signal joins", () => {
    const independence = new Map([["doc_a", "g1"], ["doc_b", "g1"]]);
    const initial = clusterPainSignals({
      signals: [{ id: "zzz_signal", signalType: "pain", quoteVerbatim: "painful handoff workflow every week", documentId: "doc_a" }],
      independenceGroupByDocumentId: independence,
    });
    const expanded = clusterPainSignals({
      signals: [
        { id: "aaa_signal", signalType: "pain", quoteVerbatim: "painful handoff workflow", documentId: "doc_b" },
        { id: "zzz_signal", signalType: "pain", quoteVerbatim: "painful handoff workflow every week", documentId: "doc_a" },
      ],
      independenceGroupByDocumentId: independence,
      previousClusters: initial,
    });
    expect(expanded).toHaveLength(1);
    expect(expanded[0]?.id).toBe(initial[0]?.id);
    expect(countNewClusters(new Set(initial.map((cluster) => cluster.id)), expanded)).toBe(0);
  });

  it("keeps cluster identity when a third similar signal joins", () => {
    const independence = new Map([["doc_a", "g1"], ["doc_b", "g1"], ["doc_c", "g1"]]);
    const quotes = [
      "painful handoff workflow",
      "painful handoff workflow every week",
      "painful handoff workflow between coding agents",
    ];
    const round1 = clusterPainSignals({
      signals: [{ id: "s1", signalType: "pain", quoteVerbatim: quotes[0]!, documentId: "doc_a" }],
      independenceGroupByDocumentId: independence,
    });
    const round2 = clusterPainSignals({
      signals: [
        { id: "s1", signalType: "pain", quoteVerbatim: quotes[0]!, documentId: "doc_a" },
        { id: "s2", signalType: "pain", quoteVerbatim: quotes[1]!, documentId: "doc_b" },
      ],
      independenceGroupByDocumentId: independence,
      previousClusters: round1,
    });
    const round3 = clusterPainSignals({
      signals: [
        { id: "s1", signalType: "pain", quoteVerbatim: quotes[0]!, documentId: "doc_a" },
        { id: "s2", signalType: "pain", quoteVerbatim: quotes[1]!, documentId: "doc_b" },
        { id: "s3", signalType: "pain", quoteVerbatim: quotes[2]!, documentId: "doc_c" },
      ],
      independenceGroupByDocumentId: independence,
      previousClusters: round2,
    });
    expect(round2[0]?.id).toBe(round1[0]?.id);
    expect(round3[0]?.id).toBe(round1[0]?.id);
    expect(countNewClusters(new Set(round2.map((cluster) => cluster.id)), round3)).toBe(0);
  });

  it("still counts genuinely distinct pains as new clusters", () => {
    const independence = new Map([["doc_a", "g1"], ["doc_b", "g2"]]);
    const initial = clusterPainSignals({
      signals: [{ id: "s1", signalType: "pain", quoteVerbatim: "painful handoff workflow", documentId: "doc_a" }],
      independenceGroupByDocumentId: independence,
    });
    const expanded = clusterPainSignals({
      signals: [
        { id: "s1", signalType: "pain", quoteVerbatim: "painful handoff workflow", documentId: "doc_a" },
        { id: "s2", signalType: "workaround", quoteVerbatim: "We paste deploy logs into a spreadsheet manually", documentId: "doc_b" },
      ],
      independenceGroupByDocumentId: independence,
      previousClusters: initial,
    });
    expect(countNewClusters(new Set(initial.map((cluster) => cluster.id)), expanded)).toBe(1);
    expect(expanded).toHaveLength(2);
  });
});

describe("balanced broad query coverage", () => {
  it("rotates languages sources and lenses under budget caps", () => {
    const plan = buildProposedSearchPlan({
      topic: "agent coding workflows",
      languages: ["en", "zh"],
      sourceFamilies: ["hn", "stack_exchange", "github_issues", "v2ex"],
      budgets: { queries: 48 },
    });
    const queries = buildBroadQueryVariants(plan);
    const stats = coverageStats(queries);
    expect(queries.length).toBe(48);
    expect(stats.languages).toBeGreaterThanOrEqual(2);
    expect(stats.sources).toBeGreaterThanOrEqual(3);
    expect(stats.lenses).toBeGreaterThanOrEqual(6);
    expect(new Set(queries.map((query) => query.source)).has("github_issues")).toBe(true);
    expect(new Set(queries.map((query) => query.source)).has("stack_exchange")).toBe(true);
    expect(queries.some((query) => query.language === "zh" && /[\u4e00-\u9fff]/.test(query.queryText))).toBe(true);
  });
});

describe("divergence and partial writeback", () => {
  it("generates divergence follow-ups when clusters are empty", () => {
    const plan = buildProposedSearchPlan({
      topic: "agent handoff",
      languages: ["en", "zh"],
      sourceFamilies: ["hn", "github_issues"],
    });
    const followUps = generateFollowUpQueries({
      plan,
      round: 2,
      clusters: [],
      existingQueryTexts: new Set(),
    });
    expect(followUps.length).toBeGreaterThan(0);
    expect(followUps.some((query) => query.language === "zh" && /[\u4e00-\u9fff]/.test(query.queryText))).toBe(true);
    expect(generateDivergenceQueries({ plan, round: 2, existingQueryTexts: new Set() }).length).toBeGreaterThan(0);
  });

  it("marks HN story/comment mixed outcomes as partial", () => {
    const updated = applyQueryExecutionWriteback(
      [{
        id: "q1",
        queryText: "x",
        language: "en",
        source: "hn",
        lens: "pain_failure",
        round: 1,
        status: "pending",
        itemCount: 0,
        error: null,
      }],
      [
        { id: "query:q1", requestKey: "query:q1", status: "success", itemCount: 2 },
        { id: "query:q1__comment", requestKey: "query:q1__comment", status: "failure", itemCount: 0, reason: "network" },
      ],
      new Set(["q1"]),
    );
    expect(updated[0]?.status).toBe("partial");
    expect(updated[0]?.itemCount).toBe(2);
  });
});

describe("runBroadResearchRounds", () => {
  const leftovers: string[] = [];

  afterEach(async () => {
    await Promise.all(leftovers.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    vi.restoreAllMocks();
  });

  async function setup(root: string, queryCount = 4) {
    const dataDir = path.join(root, "pipeline");
    const storage = openLocalStorage({ dataDir });
    const proposed = buildProposedSearchPlan({
      topic: "agent handoff pain",
      budgets: { queries: 8, documents: 50, rounds: 3 },
      sourceFamilies: ["hn", "stack_exchange"],
    });
    const confirmed = confirmSearchPlanEntity({
      ...proposed,
      queries: buildBroadQueryVariants(proposed).slice(0, queryCount),
    });
    const brief: HuntingBrief = {
      id: asId("task_rounds"),
      slug: "rounds",
      title: "agent handoff pain",
      description: "test",
      lenses: ["pain"],
      sourcesEnabled: ["hn", "stack_exchange"],
      successCriteria: "s",
      createdAt: "2026-07-11T00:00:00.000Z",
      searchPlanId: confirmed.id,
      searchPlanVersion: confirmed.version,
      queryPlan: { harvestMode: "l0" },
    };
    storage.searchPlans.save(confirmed as { readonly id: string });
    storage.huntingBriefs.save(brief);
    const runId = asId("run_multi_round");
    storage.researchRuns.save({
      id: runId,
      huntingTaskId: brief.id,
      status: "running",
      startedAt: "2026-07-11T00:00:00.000Z",
      completedAt: null,
      configHash: "cfg_test",
      errorMessage: null,
    });
    return { storage, confirmed, brief, runId };
  }

  it("executes multiple rounds, persists ledger, and writebacks query status", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-rounds-"));
    leftovers.push(root);
    const { storage, confirmed, brief, runId } = await setup(root);

    let call = 0;
    const connector = (platform: string): SourceConnector => ({
      platform,
      async healthcheck() { return { ok: true }; },
      async *search(query) {
        call += 1;
        yield {
          id: asId(`doc_${platform}_${call}`),
          runId,
          platform,
          url: `https://example.test/${platform}/${call}`,
          title: `${query.queryText ?? query.terms[0]} title`,
          rawBody: call % 3 === 0
            ? "We paste deploy logs into a spreadsheet manually every week"
            : "Monday standup notes get lost between coding agents",
          fetchedAt: "2026-07-11T00:00:00.000Z",
          fetchMethod: "test",
          language: "en",
          metadata: {},
        } as never;
      },
      async fetch() { throw new Error("not used"); },
    });

    const harvestRepo = createStorageHarvestRepository(storage);
    const harvest = createHarvestPipeline({
      connectors: [connector("hn"), connector("stack_exchange")],
      repository: harvestRepo,
    });
    const intelligence = createIntelligencePipeline({
      documents: storage.rawDocuments,
      chunks: storage.chunks,
      signals: storage.rawSignals,
      evidence: storage.evidenceItems,
      drafts: storage.opportunityDrafts,
    });

    const result = await runBroadResearchRounds({
      deps: { storage, harvest, intelligence, queryTermsFromBrief },
      brief,
      runId,
      plan: confirmed,
      execution: "new",
      effectiveConfig: { mode: "test" },
    });

    expect(result.ledger.rounds.length).toBeGreaterThanOrEqual(2);
    expect(result.queries.some((query) => query.status === "success")).toBe(true);
    expect(result.queries.every((query) => query.status === "pending")).toBe(false);
    expect(["saturated", "budget_exhausted", "budget_exhausted_partial"]).toContain(result.ledger.stopReason);

    const mid = storage.researchRunConfigs.get(runId) as { researchLedger?: { rounds: unknown[] } } | null;
    expect(mid?.researchLedger?.rounds.length).toBeGreaterThanOrEqual(2);

    const reloadedPlan = storage.searchPlans.get(confirmed.id) as typeof confirmed;
    expect(reloadedPlan.queries.some((query) => query.status === "success")).toBe(true);
    storage.close();
  });

  it("retries failed queries: increases attempts, recovers success, skips prior success legs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-retry-"));
    leftovers.push(root);
    const { storage, confirmed, brief, runId } = await setup(root, 2);

    let hnInvocations = 0;
    let seInvocations = 0;
    const firstQueryId = confirmed.queries[0]!.id;
    const commentAttempts = new Map<string, number>();
    const hn: SourceConnector = {
      platform: "hn",
      async healthcheck() { return { ok: true }; },
      async *search(query) {
        hnInvocations += 1;
        const qid = query.queryId ?? "";
        if (qid === `${firstQueryId}__comment`) {
          const n = (commentAttempts.get(qid) ?? 0) + 1;
          commentAttempts.set(qid, n);
          if (n === 1) throw new Error("network unavailable");
        }
        yield {
          id: asId(`doc_hn_${hnInvocations}`),
          huntingTaskId: brief.id,
          sourceTier: "public_api",
          platform: "hn",
          externalId: `hn_${hnInvocations}`,
          url: `https://example.test/hn/${hnInvocations}`,
          fetchedAt: "2026-07-11T00:00:00.000Z",
          fetchMethod: "api",
          fetchAgentRunId: null,
          contentType: "post",
          rawBody: "Monday standup notes get lost between coding agents",
          retentionClass: "research",
          legalBasis: "public",
        } as never;
      },
      async fetch() { throw new Error("not used"); },
    };
    const se: SourceConnector = {
      platform: "stack_exchange",
      async healthcheck() { return { ok: true }; },
      async *search() {
        seInvocations += 1;
        yield {
          id: asId(`doc_se_${seInvocations}`),
          huntingTaskId: brief.id,
          sourceTier: "public_api",
          platform: "stack_exchange",
          externalId: `se_${seInvocations}`,
          url: `https://example.test/se/${seInvocations}`,
          fetchedAt: "2026-07-11T00:00:00.000Z",
          fetchMethod: "api",
          fetchAgentRunId: null,
          contentType: "post",
          rawBody: "We paste deploy logs into a spreadsheet manually",
          retentionClass: "research",
          legalBasis: "public",
        } as never;
      },
      async fetch() { throw new Error("not used"); },
    };

    const harvestRepo = createStorageHarvestRepository(storage);
    const harvest = createHarvestPipeline({ connectors: [hn, se], repository: harvestRepo });
    const intelligence = createIntelligencePipeline({
      documents: storage.rawDocuments,
      chunks: storage.chunks,
      signals: storage.rawSignals,
      evidence: storage.evidenceItems,
      drafts: storage.opportunityDrafts,
    });

    const first = await runBroadResearchRounds({
      deps: { storage, harvest, intelligence, queryTermsFromBrief },
      brief,
      runId,
      plan: confirmed,
      execution: "new",
      effectiveConfig: { mode: "test" },
    });
    const priorRounds = first.ledger.rounds.length;
    expect(priorRounds).toBeGreaterThanOrEqual(1);
    const hnAfterFirst = hnInvocations;
    const seAfterFirst = seInvocations;

    const planAfter = storage.searchPlans.get(confirmed.id) as typeof confirmed;
    const partialOrFailed = planAfter.queries.filter((query) => query.status === "failure" || query.status === "partial");
    expect(partialOrFailed.length).toBeGreaterThan(0);

    // Terminal stop from first run must not block retry.
    expect(["budget_exhausted", "budget_exhausted_partial", "saturated"]).toContain(first.ledger.stopReason);

    const second = await runBroadResearchRounds({
      deps: { storage, harvest, intelligence, queryTermsFromBrief },
      brief,
      runId,
      plan: planAfter,
      execution: "retried",
      effectiveConfig: { mode: "test" },
      existingLedger: first.ledger,
    });

    expect(hnInvocations).toBeGreaterThan(hnAfterFirst);
    expect(seInvocations).toBe(seAfterFirst); // success SE legs not re-run
    expect(second.ledger.rounds.length).toBeGreaterThanOrEqual(priorRounds);
    expect(second.ledger.rounds[0]?.round).toBe(1);
    const recovered = second.queries.find((query) => query.id === confirmed.queries[0]!.id);
    expect(recovered?.status).toBe("success");
    expect(second.coverageIncomplete).toBe(false);
    expect(second.ledger.stopReason).not.toBe("budget_exhausted_partial");
    storage.close();
  });

  it("persists harvested checkpoint before intelligence and resumes without re-harvest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-intel-crash-"));
    leftovers.push(root);
    const dataDir = path.join(root, "pipeline");
    const storage = openLocalStorage({ dataDir });
    const proposed = buildProposedSearchPlan({
      topic: "agent handoff pain",
      budgets: { queries: 2, documents: 50, rounds: 1 },
      sourceFamilies: ["hn", "stack_exchange"],
    });
    const confirmed = confirmSearchPlanEntity({
      ...proposed,
      queries: buildBroadQueryVariants(proposed).slice(0, 2),
    });
    const brief: HuntingBrief = {
      id: asId("task_intel"),
      slug: "intel",
      title: "agent handoff pain",
      description: "test",
      lenses: ["pain"],
      sourcesEnabled: ["hn", "stack_exchange"],
      successCriteria: "s",
      createdAt: "2026-07-11T00:00:00.000Z",
      searchPlanId: confirmed.id,
      searchPlanVersion: confirmed.version,
      queryPlan: { harvestMode: "l0" },
    };
    storage.searchPlans.save(confirmed as { readonly id: string });
    storage.huntingBriefs.save(brief);
    const runId = asId("run_intel_crash");
    storage.researchRuns.save({
      id: runId,
      huntingTaskId: brief.id,
      status: "running",
      startedAt: "2026-07-11T00:00:00.000Z",
      completedAt: null,
      configHash: "cfg_test",
      errorMessage: null,
    });

    let harvestCalls = 0;
    const connector = (platform: string): SourceConnector => ({
      platform,
      async healthcheck() { return { ok: true }; },
      async *search() {
        harvestCalls += 1;
        yield {
          id: asId(`doc_${platform}_${harvestCalls}`),
          huntingTaskId: brief.id,
          sourceTier: "public_api",
          platform,
          externalId: `${platform}_${harvestCalls}`,
          url: `https://example.test/${platform}/${harvestCalls}`,
          fetchedAt: "2026-07-11T00:00:00.000Z",
          fetchMethod: "api",
          fetchAgentRunId: null,
          contentType: "post",
          rawBody: "This workflow is painful every day between coding agents",
          retentionClass: "research",
          legalBasis: "public",
        } as never;
      },
      async fetch() { throw new Error("not used"); },
    });

    const harvestRepo = createStorageHarvestRepository(storage);
    const harvest = createHarvestPipeline({
      connectors: [connector("hn"), connector("stack_exchange")],
      repository: harvestRepo,
    });
    let intelCalls = 0;
    const realIntel = createIntelligencePipeline({
      documents: storage.rawDocuments,
      chunks: storage.chunks,
      signals: storage.rawSignals,
      evidence: storage.evidenceItems,
      drafts: storage.opportunityDrafts,
    });
    const intelligence = {
      run: async (run: Parameters<typeof realIntel.run>[0], opts?: Parameters<typeof realIntel.run>[1]) => {
        intelCalls += 1;
        if (intelCalls === 1) throw new Error("intelligence crashed");
        return realIntel.run(run, opts);
      },
    };

    await expect(runBroadResearchRounds({
      deps: { storage, harvest, intelligence, queryTermsFromBrief },
      brief,
      runId,
      plan: confirmed,
      execution: "new",
      effectiveConfig: { mode: "test" },
    })).rejects.toThrow("intelligence crashed");

    const midConfig = storage.researchRunConfigs.get(runId) as {
      researchLedger?: {
        lastCheckpoint?: {
          phase: string;
          round: number;
          docsBefore?: number;
          evidenceBefore?: number;
          knownClusterIds?: readonly string[];
        };
        stopReason: string;
      };
    };
    const checkpoint = midConfig.researchLedger?.lastCheckpoint;
    expect(checkpoint?.phase).toBe("harvested");
    expect(checkpoint?.docsBefore).toBe(0);
    expect(checkpoint?.evidenceBefore).toBe(0);
    expect(checkpoint?.knownClusterIds).toEqual([]);
    const midPlan = storage.searchPlans.get(confirmed.id) as typeof confirmed;
    expect(midPlan.queries.some((query) => query.status === "success")).toBe(true);
    const docsAfterHarvest = storage.rawDocuments.listByRun(runId).length;
    const evidenceAfterHarvest = storage.evidenceItems.listByRun(runId).length;
    const signalsAfterHarvest = storage.rawSignals.listByRun(runId);
    expect(docsAfterHarvest).toBeGreaterThan(checkpoint!.docsBefore!);
    expect(evidenceAfterHarvest).toBe(checkpoint!.evidenceBefore!);
    expect(signalsAfterHarvest.length).toBeGreaterThan(0);
    const clustersIfWrongBaseline = clusterPainSignals({
      signals: signalsAfterHarvest,
      independenceGroupByDocumentId: new Map(),
    });
    expect(clustersIfWrongBaseline.length).toBeGreaterThan(0);
    const harvestAfterCrash = harvestCalls;

    const resumed = await runBroadResearchRounds({
      deps: { storage, harvest, intelligence, queryTermsFromBrief },
      brief,
      runId,
      plan: midPlan,
      execution: "resumed",
      effectiveConfig: { mode: "test" },
      existingLedger: midConfig.researchLedger as never,
    });

    expect(harvestCalls).toBe(harvestAfterCrash);
    expect(intelCalls).toBeGreaterThanOrEqual(2);
    expect(resumed.ledger.lastCheckpoint?.phase).toBe("round_complete");
    expect(resumed.ledger.rounds.length).toBeGreaterThanOrEqual(1);
    const round1 = resumed.ledger.rounds.find((round) => round.round === 1);
    expect(round1).toBeDefined();
    const docsFinal = storage.rawDocuments.listByRun(runId).length;
    const evidenceFinal = storage.evidenceItems.listByRun(runId).length;
    expect(round1!.newDocumentCount).toBe(docsFinal - checkpoint!.docsBefore!);
    expect(round1!.newEvidenceCount).toBe(evidenceFinal - checkpoint!.evidenceBefore!);
    expect(round1!.newDocumentCount).toBe(docsAfterHarvest - checkpoint!.docsBefore!);
    expect(round1!.newDocumentCount).toBeGreaterThan(0);
    expect(round1!.newClusterCount).toBeGreaterThan(0);
    expect(round1!.newClusterCount).toBe(
      countNewClusters(new Set(checkpoint!.knownClusterIds ?? []), clustersIfWrongBaseline),
    );
    expect(resumed.ledger.stopReason).not.toBe("saturated");
    storage.close();
  });

  it("crash/resume newClusterCount matches clean run and does not false-saturate", async () => {
    const painBody = "This workflow is painful every day between coding agents";

    async function runOnce(mode: "clean" | "crash-resume") {
      const root = await mkdtemp(path.join(os.tmpdir(), `idea-finder-cluster-${mode}-`));
      leftovers.push(root);
      const dataDir = path.join(root, "pipeline");
      const storage = openLocalStorage({ dataDir });
      const proposed = buildProposedSearchPlan({
        topic: "agent handoff pain",
        budgets: { queries: 4, documents: 50, rounds: 3 },
        sourceFamilies: ["hn", "stack_exchange"],
      });
      const round1Done = buildBroadQueryVariants(proposed).slice(0, 1).map((query) => ({
        ...query,
        round: 1,
        status: "success" as const,
        itemCount: 1,
      }));
      const round2Pending = buildBroadQueryVariants(proposed).slice(1, 2).map((query) => ({
        ...query,
        id: `${query.id}_r2`,
        round: 2,
        status: "pending" as const,
        itemCount: 0,
      }));
      const confirmed = confirmSearchPlanEntity({
        ...proposed,
        queries: [...round1Done, ...round2Pending],
        budgets: { queries: 4, documents: 50, rounds: 3 },
      });
      const brief: HuntingBrief = {
        id: asId(`task_cluster_${mode}`),
        slug: `cluster_${mode}`,
        title: "agent handoff pain",
        description: "test",
        lenses: ["pain"],
        sourcesEnabled: ["hn", "stack_exchange"],
        successCriteria: "s",
        createdAt: "2026-07-11T00:00:00.000Z",
        searchPlanId: confirmed.id,
        searchPlanVersion: confirmed.version,
        queryPlan: { harvestMode: "l0" },
      };
      storage.searchPlans.save(confirmed as { readonly id: string });
      storage.huntingBriefs.save(brief);
      const runId = asId(`run_cluster_${mode}`);
      storage.researchRuns.save({
        id: runId,
        huntingTaskId: brief.id,
        status: "running",
        startedAt: "2026-07-11T00:00:00.000Z",
        completedAt: null,
        configHash: "cfg_test",
        errorMessage: null,
      });
      // Prior round reported zero new clusters — a false zero on resume would trip saturated.
      storage.researchRunConfigs.save({
        id: runId,
        effectiveConfig: { mode: "test" },
        execution: "resumed",
        researchLedger: {
          rounds: [{
            round: 1,
            queryIds: round1Done.map((query) => query.id),
            newDocumentCount: 1,
            newEvidenceCount: 1,
            newClusterCount: 0,
            coverageIncomplete: false,
          }],
          stopReason: "continue",
        },
      });

      let harvestCalls = 0;
      const connector = (platform: string): SourceConnector => ({
        platform,
        async healthcheck() { return { ok: true }; },
        async *search() {
          harvestCalls += 1;
          yield {
            id: asId(`doc_${platform}_${mode}_${harvestCalls}`),
            huntingTaskId: brief.id,
            sourceTier: "public_api",
            platform,
            externalId: `${platform}_${mode}_${harvestCalls}`,
            url: `https://example.test/${platform}/${mode}/${harvestCalls}`,
            fetchedAt: "2026-07-11T00:00:00.000Z",
            fetchMethod: "api",
            fetchAgentRunId: null,
            contentType: "post",
            rawBody: painBody,
            retentionClass: "research",
            legalBasis: "public",
          } as never;
        },
        async fetch() { throw new Error("not used"); },
      });
      const harvest = createHarvestPipeline({
        connectors: [connector("hn"), connector("stack_exchange")],
        repository: createStorageHarvestRepository(storage),
      });
      const realIntel = createIntelligencePipeline({
        documents: storage.rawDocuments,
        chunks: storage.chunks,
        signals: storage.rawSignals,
        evidence: storage.evidenceItems,
        drafts: storage.opportunityDrafts,
      });
      let intelCalls = 0;
      const intelligence = {
        run: async (run: Parameters<typeof realIntel.run>[0], opts?: Parameters<typeof realIntel.run>[1]) => {
          intelCalls += 1;
          if (mode === "crash-resume" && intelCalls === 1) throw new Error("intelligence crashed");
          return realIntel.run(run, opts);
        },
      };

      const deps = { storage, harvest, intelligence, queryTermsFromBrief };
      if (mode === "crash-resume") {
        await expect(runBroadResearchRounds({
          deps,
          brief,
          runId,
          plan: confirmed,
          execution: "resumed",
          effectiveConfig: { mode: "test" },
        })).rejects.toThrow("intelligence crashed");
        const midConfig = storage.researchRunConfigs.get(runId) as {
          researchLedger?: {
            lastCheckpoint?: { knownClusterIds?: readonly string[]; phase: string };
          };
        };
        expect(midConfig.researchLedger?.lastCheckpoint?.phase).toBe("harvested");
        expect(midConfig.researchLedger?.lastCheckpoint?.knownClusterIds).toEqual([]);
        const midPlan = storage.searchPlans.get(confirmed.id) as typeof confirmed;
        const result = await runBroadResearchRounds({
          deps,
          brief,
          runId,
          plan: midPlan,
          execution: "resumed",
          effectiveConfig: { mode: "test" },
          existingLedger: midConfig.researchLedger as never,
        });
        storage.close();
        return result;
      }

      const result = await runBroadResearchRounds({
        deps,
        brief,
        runId,
        plan: confirmed,
        execution: "resumed",
        effectiveConfig: { mode: "test" },
      });
      storage.close();
      return result;
    }

    const clean = await runOnce("clean");
    const resumed = await runOnce("crash-resume");
    const cleanRound2 = clean.ledger.rounds.find((round) => round.round === 2);
    const resumedRound2 = resumed.ledger.rounds.find((round) => round.round === 2);
    expect(cleanRound2?.newClusterCount).toBeGreaterThan(0);
    expect(resumedRound2?.newClusterCount).toBe(cleanRound2!.newClusterCount);
    expect(resumed.ledger.stopReason).not.toBe("saturated");
    expect(clean.ledger.stopReason).not.toBe("saturated");
  });

  it("preserves same-round newClusterCount across retry and avoids false saturation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-round-retry-cluster-"));
    leftovers.push(root);
    const dataDir = path.join(root, "pipeline");
    const storage = openLocalStorage({ dataDir });
    const proposed = buildProposedSearchPlan({
      topic: "agent handoff pain",
      budgets: { queries: 4, documents: 50, rounds: 3 },
      sourceFamilies: ["hn", "stack_exchange"],
    });
    const round1Done = buildBroadQueryVariants(proposed).slice(0, 1).map((query) => ({
      ...query,
      round: 1,
      status: "success" as const,
      itemCount: 1,
    }));
    const round2Pending = buildBroadQueryVariants(proposed).slice(1, 2).map((query) => ({
      ...query,
      id: `${query.id}_r2`,
      round: 2,
      status: "pending" as const,
      itemCount: 0,
    }));
    const confirmed = confirmSearchPlanEntity({
      ...proposed,
      queries: [...round1Done, ...round2Pending],
      budgets: { queries: 4, documents: 50, rounds: 3 },
    });
    const brief: HuntingBrief = {
      id: asId("task_round_retry_cluster"),
      slug: "round_retry_cluster",
      title: "agent handoff pain",
      description: "test",
      lenses: ["pain"],
      sourcesEnabled: ["hn", "stack_exchange"],
      successCriteria: "s",
      createdAt: "2026-07-11T00:00:00.000Z",
      searchPlanId: confirmed.id,
      searchPlanVersion: confirmed.version,
      queryPlan: { harvestMode: "l0" },
    };
    storage.searchPlans.save(confirmed as { readonly id: string });
    storage.huntingBriefs.save(brief);
    const runId = asId("run_round_retry_cluster");
    storage.researchRuns.save({
      id: runId,
      huntingTaskId: brief.id,
      status: "running",
      startedAt: "2026-07-11T00:00:00.000Z",
      completedAt: null,
      configHash: "cfg_test",
      errorMessage: null,
    });
    storage.researchRunConfigs.save({
      id: runId,
      effectiveConfig: { mode: "test" },
      execution: "resumed",
      researchLedger: {
        rounds: [{
          round: 1,
          queryIds: round1Done.map((query) => query.id),
          newDocumentCount: 1,
          newEvidenceCount: 1,
          newClusterCount: 0,
          coverageIncomplete: false,
        }],
        stopReason: "continue",
      },
    });

    const painBody = "This workflow is painful every day between coding agents";
    const connector = (platform: string): SourceConnector => ({
      platform,
      async healthcheck() { return { ok: true }; },
      async *search() {
        yield {
          id: asId(`doc_${platform}_retry_cluster`),
          huntingTaskId: brief.id,
          sourceTier: "public_api",
          platform,
          externalId: `${platform}_retry_cluster`,
          url: `https://example.test/${platform}/retry_cluster`,
          fetchedAt: "2026-07-11T00:00:00.000Z",
          fetchMethod: "api",
          fetchAgentRunId: null,
          contentType: "post",
          rawBody: painBody,
          retentionClass: "research",
          legalBasis: "public",
        } as never;
      },
      async fetch() { throw new Error("not used"); },
    });
    const deps = {
      storage,
      harvest: createHarvestPipeline({
        connectors: [connector("hn"), connector("stack_exchange")],
        repository: createStorageHarvestRepository(storage),
      }),
      intelligence: createIntelligencePipeline({
        documents: storage.rawDocuments,
        chunks: storage.chunks,
        signals: storage.rawSignals,
        evidence: storage.evidenceItems,
        drafts: storage.opportunityDrafts,
      }),
      queryTermsFromBrief,
    };

    const first = await runBroadResearchRounds({
      deps,
      brief,
      runId,
      plan: confirmed,
      execution: "resumed",
      effectiveConfig: { mode: "test" },
    });
    const round2AfterFirst = first.ledger.rounds.find((round) => round.round === 2);
    expect(round2AfterFirst?.newClusterCount).toBeGreaterThan(0);

    const planAfterFirst = storage.searchPlans.get(confirmed.id) as typeof confirmed;
    const retryPlan = {
      ...planAfterFirst,
      queries: planAfterFirst.queries.map((query) => (
        query.round === 2
          ? { ...query, status: "partial" as const, error: "forced retry" }
          : query
      )),
    };
    storage.searchPlans.save(retryPlan as { readonly id: string });

    const second = await runBroadResearchRounds({
      deps,
      brief,
      runId,
      plan: retryPlan,
      execution: "retried",
      effectiveConfig: { mode: "test" },
      existingLedger: first.ledger,
    });

    const round2AfterRetry = second.ledger.rounds.find((round) => round.round === 2);
    expect(round2AfterRetry?.newClusterCount).toBe(round2AfterFirst?.newClusterCount);
    expect(round2AfterRetry?.newDocumentCount).toBeGreaterThanOrEqual(round2AfterFirst?.newDocumentCount ?? 0);
    expect(round2AfterRetry?.newEvidenceCount).toBeGreaterThanOrEqual(round2AfterFirst?.newEvidenceCount ?? 0);
    expect(second.ledger.stopReason).not.toBe("saturated");
    expect(second.coverageIncomplete).toBe(false);
    storage.close();
  });

  it("atomically rolls back SearchPlan and ledger when transaction save fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idea-finder-tx-"));
    leftovers.push(root);
    const { storage, confirmed, brief, runId } = await setup(root, 2);

    const connector = (platform: string): SourceConnector => ({
      platform,
      async healthcheck() { return { ok: true }; },
      async *search() {
        yield {
          id: asId(`doc_${platform}_tx`),
          huntingTaskId: brief.id,
          sourceTier: "public_api",
          platform,
          externalId: `${platform}_tx`,
          url: `https://example.test/${platform}/tx`,
          fetchedAt: "2026-07-11T00:00:00.000Z",
          fetchMethod: "api",
          fetchAgentRunId: null,
          contentType: "post",
          rawBody: "painful handoff workflow",
          retentionClass: "research",
          legalBasis: "public",
        } as never;
      },
      async fetch() { throw new Error("not used"); },
    });
    const harvest = createHarvestPipeline({
      connectors: [connector("hn"), connector("stack_exchange")],
      repository: createStorageHarvestRepository(storage),
    });
    const intelligence = createIntelligencePipeline({
      documents: storage.rawDocuments,
      chunks: storage.chunks,
      signals: storage.rawSignals,
      evidence: storage.evidenceItems,
      drafts: storage.opportunityDrafts,
    });

    let saveCount = 0;
    const originalSave = storage.researchRunConfigs.save.bind(storage.researchRunConfigs);
    storage.researchRunConfigs.save = ((record: { readonly id: string }) => {
      saveCount += 1;
      if (saveCount === 1) throw new Error("forced config save failure");
      return originalSave(record);
    }) as typeof storage.researchRunConfigs.save;

    const beforePlan = storage.searchPlans.get(confirmed.id) as typeof confirmed;
    await expect(runBroadResearchRounds({
      deps: { storage, harvest, intelligence, queryTermsFromBrief },
      brief,
      runId,
      plan: confirmed,
      execution: "new",
      effectiveConfig: { mode: "test" },
    })).rejects.toThrow("forced config save failure");

    const afterPlan = storage.searchPlans.get(confirmed.id) as typeof confirmed;
    // Transaction rollback: query statuses should remain pending (plan not partially committed).
    expect(afterPlan.queries.every((query) => query.status === "pending")).toBe(true);
    expect(afterPlan.queries.map((query) => query.id)).toEqual(beforePlan.queries.map((query) => query.id));
    expect(storage.researchRunConfigs.get(runId)?.researchLedger).toBeUndefined();
    storage.close();
  });
});

describe("evaluateStopCondition", () => {
  it("requires two zero-new-cluster rounds before saturated", () => {
    expect(evaluateStopCondition({
      rounds: [
        { round: 1, queryIds: ["q1"], newDocumentCount: 2, newEvidenceCount: 1, newClusterCount: 1, coverageIncomplete: false },
        { round: 2, queryIds: ["q2"], newDocumentCount: 0, newEvidenceCount: 0, newClusterCount: 0, coverageIncomplete: false },
      ],
      budgets: { queries: 100, documents: 100, rounds: 5 },
      executedQueryCount: 2,
      documentCount: 2,
      coverageIncomplete: false,
    })).toBe("continue");

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


describe("recomputeCoverageIncomplete", () => {
  it("ignores stale source failures outside the scoped round queries", async () => {
    const { recomputeCoverageIncomplete } = await import("../src/orchestration/broad-research-rounds.js");
    const round2Queries = [{
      id: "q2",
      queryText: "x",
      language: "en",
      source: "hn",
      lens: "pain_failure",
      round: 2,
      status: "success" as const,
      itemCount: 1,
      error: null,
    }];
    const sourceStatuses = [
      { id: "query:q1", requestKey: "query:q1", status: "failure", itemCount: 0 },
      { id: "query:q2", requestKey: "query:q2", status: "success", itemCount: 1 },
    ];
    expect(recomputeCoverageIncomplete(round2Queries, sourceStatuses)).toBe(false);
    expect(recomputeCoverageIncomplete([{ ...round2Queries[0]!, status: "partial" }], sourceStatuses)).toBe(true);
  });
});
